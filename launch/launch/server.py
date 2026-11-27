"""Launch API server: OpenAI-compatible chat completions + KSTRL account endpoints."""
from __future__ import annotations

import asyncio
import json
import threading
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .chat import ChatFormat, ToolStream
from .engine import Engine, SampleParams
from .store import HOME, Store, credits, next_reset_ms

UUID_RE = __import__("re").compile(r"^[0-9a-fA-F-]{32,36}$")


def err(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


def create_app(engine: Engine, store: Store, auth: bool = True, model_id: str | None = None) -> FastAPI:
    app = FastAPI(title="Launch", docs_url=None, redoc_url=None)
    fmt = ChatFormat(engine.tok_config)
    model_name = model_id or engine.name
    crash_log = HOME / "crash.log"

    def client_ip(req: Request) -> str:
        return req.client.host if req.client else "?"

    def require_key(req: Request):
        if not auth:
            return None, None
        h = req.headers.get("authorization", "")
        key = h[7:].strip() if h.lower().startswith("bearer ") else ""
        row = store.lookup(key)
        if not row:
            return None, err(401, "invalid_key", "Invalid API key")
        return row, None

    @app.get("/health")
    def health():
        return {"ok": True, "model": model_name}

    @app.get("/v1/models")
    def models(req: Request):
        _, e = require_key(req)
        if e:
            return e
        return {"object": "list", "data": [{"id": model_name, "object": "model", "owned_by": "launch", "created": int(time.time())}]}

    # ---- KSTRL: automatic keys ----
    @app.post("/v1/kstrl/register")
    async def register(req: Request):
        try:
            body = await req.json()
        except Exception:
            return err(400, "bad_request", "Send JSON")
        install = str(body.get("install_id", ""))
        if not UUID_RE.match(install):
            return err(400, "bad_request", "install_id must be a UUID")
        row = store.by_install(install)
        if row and row["banned"]:
            return err(403, "banned", "This install is blocked")
        if row and not row["revoked"] and row["secret"]:
            return {"key": row["secret"], "plan": row["plan"]}
        ip = client_ip(req)
        if store.created_since(86400, ip) >= 3 or store.created_since(3600) >= 200:
            return err(429, "rate_limited", "Too many sign-ups, try later")
        key = store.create(plan="free", install_id=install, ip=ip)
        return {"key": key, "plan": "free"}

    # ---- KSTRL: sign up / log in from the app's own screen ----
    EMAIL_RE = __import__("re").compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")
    attempts: dict[str, list[float]] = {}

    def too_many(ip: str, limit: int = 10, window: float = 600) -> bool:
        recent = [t for t in attempts.get(ip, []) if time.time() - t < window]
        recent.append(time.time())
        attempts[ip] = recent
        return len(recent) > limit

    def session(user, ip, install):
        key = store.create(plan=user["plan"], name=user["name"], email=user["email"], install_id=install, ip=ip, user_id=user["id"])
        return {"key": key, "name": user["name"], "email": user["email"], "plan": user["plan"]}

    async def read_auth(req: Request):
        try:
            body = await req.json()
        except Exception:
            return None, err(400, "bad_request", "Send JSON")
        email = str(body.get("email", "")).strip()[:254]
        password = str(body.get("password", ""))
        install = str(body.get("install_id", ""))
        if not EMAIL_RE.match(email):
            return None, err(400, "bad_email", "Enter a valid email address")
        if not password:
            return None, err(400, "bad_password", "Enter your password")
        return {"email": email, "password": password, "name": str(body.get("name", "")).strip()[:80],
                "install": install if UUID_RE.match(install) else None}, None

    @app.post("/v1/kstrl/auth/signup")
    async def signup(req: Request):
        b, e = await read_auth(req)
        if e:
            return e
        ip = client_ip(req)
        if too_many(ip) or store.users_since(86400, ip) >= 5:
            return err(429, "rate_limited", "Too many attempts. Try again later.")
        if len(b["password"]) < 8 or len(b["password"]) > 200:
            return err(400, "weak_password", "Use a password with at least 8 characters")
        if store.user(b["email"]):
            return err(409, "email_taken", "An account with this email already exists. Log in instead.")
        uid = store.add_user(b["email"], b["password"], b["name"] or b["email"].split("@")[0], ip)
        return session(store.db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone(), ip, b["install"])

    @app.post("/v1/kstrl/auth/login")
    async def login(req: Request):
        b, e = await read_auth(req)
        if e:
            return e
        ip = client_ip(req)
        if too_many(ip):
            return err(429, "rate_limited", "Too many attempts. Try again in a few minutes.")
        u = store.user(b["email"])
        ok = Store.check_pw(b["password"], u["pw"]) if u else Store.check_pw(b["password"], Store.hash_pw("x"))  # same work either way
        if not u or not ok:
            return err(401, "bad_credentials", "Wrong email or password")
        if u["banned"]:
            return err(403, "banned", "This account is blocked")
        return session(u, ip, b["install"])

    @app.post("/v1/kstrl/auth/logout")
    def logout(req: Request):
        row, e = require_key(req)
        if row is not None and row.get("user_id"):
            store.set(row["hash"], revoked=1)
        return Response(status_code=204)

    @app.get("/v1/kstrl/account")
    def account(req: Request):
        row, e = require_key(req)
        if e:
            return e
        if row is None:
            return {"name": "", "email": "", "plan": "max", "usage": {"used": 0, "limit": 50000, "resetsAt": next_reset_ms()}}
        return {"name": row["name"] or "", "email": row["email"] or "", "plan": row["plan"],
                "usage": {"used": round(store.used(row["usage_id"]), 1), "limit": store.limit(row), "resetsAt": next_reset_ms()}}

    crash_count: dict[str, list[float]] = {}

    @app.post("/v1/kstrl/crash")
    async def crash(req: Request):
        try:
            body = await req.json()
        except Exception:
            return Response(status_code=204)
        who = client_ip(req)
        recent = [t for t in crash_count.get(who, []) if time.time() - t < 3600]
        if len(recent) < 20:
            recent.append(time.time())
            crash_count[who] = recent
            entry = json.dumps({k: str(body.get(k, ""))[:4000] for k in ("version", "platform", "arch", "source", "message", "stack")})
            with open(crash_log, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {entry[:16000]}\n")
        return Response(status_code=204)

    # ---- chat completions ----
    @app.post("/v1/chat/completions")
    async def chat(req: Request):
        row, e = require_key(req)
        if e:
            return e
        if row is not None and store.used(row["usage_id"]) >= store.limit(row):
            return err(429, "usage_limit", "Daily usage limit reached")
        try:
            body = await req.json()
        except Exception:
            return err(400, "bad_request", "Send JSON")
        messages = body.get("messages") or []
        tools = body.get("tools") or None
        if tools and body.get("tool_choice") == "none":
            tools = None
        try:
            prompt = fmt.render(messages, tools)
        except Exception as ex:
            return err(400, "template_error", f"Could not format the conversation: {ex}")
        ids = engine.encode(prompt)
        if len(ids) >= engine.model.max_ctx:
            return err(400, "context_length_exceeded", f"The conversation is {len(ids)} tokens but the model is loaded with a {engine.model.max_ctx}-token context. Start a new chat, or restart Launch with a bigger --ctx.")
        stop = body.get("stop") or []
        params = SampleParams(
            max_tokens=int(body.get("max_tokens") or body.get("max_completion_tokens") or 4096),
            temperature=float(body.get("temperature", 0.7)),
            top_p=float(body.get("top_p", 0.95)),
            top_k=int(body.get("top_k", 50)),
            stop=[stop] if isinstance(stop, str) else list(stop),
        )
        mode, kmodel = req.headers.get("x-kstrl-mode"), req.headers.get("x-kstrl-model")
        stream = bool(body.get("stream"))
        include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())
        cancel = threading.Event()
        q: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_running_loop()

        def worker():
            try:
                for ev in engine.generate(ids, params, cancel):
                    loop.call_soon_threadsafe(q.put_nowait, ev)
            except Exception as ex:  # noqa: BLE001
                loop.call_soon_threadsafe(q.put_nowait, {"error": str(ex)})
            loop.call_soon_threadsafe(q.put_nowait, None)

        threading.Thread(target=worker, daemon=True).start()
        ts = ToolStream(bool(tools))

        def bill(ev):
            if row is not None:
                store.add_usage(row["usage_id"], credits(ev["prompt_tokens"], ev["completion_tokens"], kmodel, mode))

        def chunk(delta, finish=None):
            return "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model_name,
                                          "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"

        if stream:
            async def gen():
                finished = False
                yield chunk({"role": "assistant", "content": ""})
                try:
                    while True:
                        if await req.is_disconnected():
                            cancel.set()
                        ev = await q.get()
                        if ev is None:
                            finished = True
                            break
                        if "error" in ev:
                            yield "data: " + json.dumps({"error": {"code": "engine_error", "message": ev["error"]}}) + "\n\n"
                            break
                        if "text" in ev:
                            shown = ts.feed(ev["text"])
                            if shown:
                                yield chunk({"content": shown})
                            continue
                        bill(ev)  # count usage first, even if the client has gone away
                        finished = True
                        rest = ts.finish()
                        if rest:
                            yield chunk({"content": rest})
                        for i, c in enumerate(ts.calls):
                            yield chunk({"tool_calls": [{"index": i, **c}]})
                        yield chunk({}, "tool_calls" if ts.calls else ("length" if ev["finish"] == "length" else "stop"))
                        if include_usage:
                            yield "data: " + json.dumps({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model_name, "choices": [],
                                                         "usage": {"prompt_tokens": ev["prompt_tokens"], "completion_tokens": ev["completion_tokens"],
                                                                   "total_tokens": ev["prompt_tokens"] + ev["completion_tokens"]}}) + "\n\n"
                    yield "data: [DONE]\n\n"
                finally:
                    cancel.set()
                    # the client left early: finish draining in the background so the tokens are still counted
                    async def drain():
                        while True:
                            ev = await q.get()
                            if ev is None:
                                return
                            if ev.get("done"):
                                bill(ev)
                    if not finished:
                        asyncio.ensure_future(drain())
            return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

        text = ""
        final = None
        while True:
            ev = await q.get()
            if ev is None:
                break
            if "error" in ev:
                return err(500, "engine_error", ev["error"])
            if "text" in ev:
                text += ts.feed(ev["text"])
            else:
                final = ev
        text += ts.finish()
        bill(final)
        msg = {"role": "assistant", "content": text or (None if ts.calls else "")}
        if ts.calls:
            msg["tool_calls"] = ts.calls
        return {"id": cid, "object": "chat.completion", "created": created, "model": model_name,
                "choices": [{"index": 0, "message": msg, "finish_reason": "tool_calls" if ts.calls else ("length" if final["finish"] == "length" else "stop")}],
                "usage": {"prompt_tokens": final["prompt_tokens"], "completion_tokens": final["completion_tokens"],
                          "total_tokens": final["prompt_tokens"] + final["completion_tokens"]}}

    return app
