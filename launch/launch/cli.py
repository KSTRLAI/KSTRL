"""launch — command line for the Launch runner.

  launch pull <hf-repo>              download a model from Hugging Face
  launch list                        downloaded models
  launch rm <model>                  delete a downloaded model
  launch run <model> "prompt"        quick test in the terminal
  launch serve <model> [--port 8000] [--host 127.0.0.1] [--ctx 8192] [--no-auth]
  launch keys create [--plan free|max] [--name N] [--email E]
  launch keys list
  launch keys plan <key|prefix|install_id> free|max
  launch keys revoke <key|prefix|install_id>
  launch keys ban <key|prefix|install_id>
  launch users list                  accounts made from KSTRL's sign-up screen
  launch users plan <email> free|max
  launch users ban <email>
  (add --json to list commands for machine-readable output)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

from . import __version__


def cmd_pull(a):
    from .hub import pull
    print(f"Downloading {a.repo} from Hugging Face…")
    path = pull(a.repo, token=a.token or os.environ.get("HF_TOKEN"))
    print(f"Done: {path}")


def cmd_list(a):
    from .hub import installed
    ms = installed()
    if a.json:
        print(json.dumps([{**m, "path": str(m["path"])} for m in ms]))
        return
    if not ms:
        print("No models yet. Try: launch pull Qwen/Qwen2.5-Coder-1.5B-Instruct")
    for m in ms:
        print(f"{m['id']:60} {m['arch']:8} {m['gb']:>7} GB")


def cmd_rm(a):
    from .hub import remove
    remove(a.model)
    print("Removed.")


def load_engine(a):
    from .engine import Engine
    from .hub import resolve
    path = resolve(a.model)
    t = time.time()
    print(f"Loading {a.model} with the Launch engine…", flush=True)
    eng = Engine(path, device=a.device, max_ctx=a.ctx, name=a.model)
    m = eng.model
    print(f"Ready in {time.time() - t:.1f}s on {m.device} ({str(m.dtype).replace('torch.', '')}), {m.cfg.layers} layers, context {m.max_ctx}.", flush=True)
    return eng


def cmd_run(a):
    from .chat import ChatFormat
    from .engine import SampleParams
    eng = load_engine(a)
    ids = eng.encode(ChatFormat(eng.tok_config).render([{"role": "user", "content": a.prompt}]))
    t = time.time()
    n = 0
    for ev in eng.generate(ids, SampleParams(max_tokens=a.max_tokens, temperature=a.temperature)):
        if "text" in ev:
            print(ev["text"], end="", flush=True)
        else:
            n = ev["completion_tokens"]
    print(f"\n\n[{n} tokens, {n / max(1e-6, time.time() - t):.1f} tok/s]")


def cmd_serve(a):
    import uvicorn
    from .server import create_app
    from .store import Store
    eng = load_engine(a)
    app = create_app(eng, Store(), auth=not a.no_auth, model_id=a.model)
    if not a.no_auth:
        print("API keys are required (Authorization: Bearer …). KSTRL installs get one automatically from /v1/kstrl/register.")
    print(f"Launch API on http://{a.host}:{a.port}/v1")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


def cmd_keys(a):
    from .store import Store
    s = Store()
    if a.action == "create":
        key = s.create(plan=a.plan, name=a.name or "", email=a.email or "")
        print(key)
        print("Save it now — Launch only stores a hash of manually created keys.", file=sys.stderr)
        return
    if a.action == "list":
        if a.json:
            print(json.dumps([{"prefix": r["prefix"], "plan": r["plan"], "state": "banned" if r["banned"] else "revoked" if r["revoked"] else "active",
                               "used": round(r["used"], 1), "name": r["name"] or "", "email": r["email"] or "", "install": bool(r["install_id"]),
                               "account": bool(r["user_id"]), "created": r["created_at"]} for r in s.all()]))
            return
        for r in s.all():
            state = "banned" if r["banned"] else "revoked" if r["revoked"] else "active"
            who = r["name"] or r["email"] or (f"install {r['install_id'][:8]}" if r["install_id"] else "")
            print(f"{r['prefix']}…  {r['plan']:4}  {state:7}  {r['used']:>8.1f} credits today  {who}")
        return
    row = s.find(a.ref)
    if not row:
        sys.exit(f"No key matches {a.ref}")
    if a.action == "plan":
        s.set(row["hash"], plan=a.value)
    elif a.action == "revoke":
        s.set(row["hash"], revoked=1)
    elif a.action == "ban":
        s.set(row["hash"], banned=1)
    print("Done.")


def cmd_users(a):
    from .store import Store
    s = Store()
    if a.action == "list":
        rows = [{"email": u["email"], "name": u["name"], "plan": u["plan"], "banned": bool(u["banned"]), "used": round(u["used"], 1), "created": u["created_at"]} for u in s.users()]
        if a.json:
            print(json.dumps(rows))
            return
        if not rows:
            print("No accounts yet.")
        for u in rows:
            print(f"{u['email']:40} {u['plan']:4} {'banned' if u['banned'] else 'active':7} {u['used']:>8.1f} credits today  {u['name']}")
        return
    u = s.user(a.email)
    if not u:
        sys.exit(f"No account with email {a.email}")
    if a.action == "plan":
        s.set_user(u["id"], plan=a.value)
    elif a.action == "ban":
        s.set_user(u["id"], banned=1)
    print("Done.")


def main(argv=None):
    p = argparse.ArgumentParser(prog="launch", description="Launch: local AI runner with the Launch engine.")
    p.add_argument("--version", action="version", version=f"launch {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("pull", help="download a model from Hugging Face"); s.add_argument("repo"); s.add_argument("--token"); s.set_defaults(fn=cmd_pull)
    s = sub.add_parser("list", help="downloaded models"); s.add_argument("--json", action="store_true"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("rm", help="delete a model"); s.add_argument("model"); s.set_defaults(fn=cmd_rm)
    for name, fn in (("run", cmd_run), ("serve", cmd_serve)):
        s = sub.add_parser(name)
        s.add_argument("model")
        if name == "run":
            s.add_argument("prompt")
            s.add_argument("--max-tokens", type=int, default=512)
            s.add_argument("--temperature", type=float, default=0.7)
        else:
            s.add_argument("--host", default="127.0.0.1")
            s.add_argument("--port", type=int, default=8000)
            s.add_argument("--no-auth", action="store_true", help="no API keys (only for use on this PC)")
        s.add_argument("--ctx", type=int, default=16384, help="context length in tokens")
        s.add_argument("--device", help="cuda, mps or cpu (default: best available)")
        s.set_defaults(fn=fn)
    s = sub.add_parser("keys", help="manage API keys")
    ks = s.add_subparsers(dest="action", required=True)
    c = ks.add_parser("create"); c.add_argument("--plan", default="free", choices=["free", "max"]); c.add_argument("--name"); c.add_argument("--email")
    ks.add_parser("list").add_argument("--json", action="store_true")
    c = ks.add_parser("plan"); c.add_argument("ref"); c.add_argument("value", choices=["free", "max"])
    c = ks.add_parser("revoke"); c.add_argument("ref")
    c = ks.add_parser("ban"); c.add_argument("ref")
    s.set_defaults(fn=cmd_keys)
    s = sub.add_parser("users", help="manage accounts")
    us = s.add_subparsers(dest="action", required=True)
    us.add_parser("list").add_argument("--json", action="store_true")
    c = us.add_parser("plan"); c.add_argument("email"); c.add_argument("value", choices=["free", "max"])
    c = us.add_parser("ban"); c.add_argument("email")
    s.set_defaults(fn=cmd_users)
    a = p.parse_args(argv)
    try:
        a.fn(a)
    except (FileNotFoundError, ValueError, RuntimeError) as e:
        sys.exit(f"Error: {e}")


if __name__ == "__main__":
    main()
