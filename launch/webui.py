"""Launch's window: a KSTRL-style web UI served from 127.0.0.1 and shown in an app window (Microsoft Edge app mode).

Launch.exe starts a private control server on a random local port (only this PC, and every request must carry
a per-run token), opens webui/index.html in a chromeless Edge window, and closes when that window closes.
Everything the old Tk window did goes through /api/*: setup, models, server, chat, keys, accounts and updates.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
B = None  # the bootstrap module
TOKEN = secrets.token_urlsafe(24)
PORT = 0
LOCK = threading.Lock()

S = {
    "setup": {"ready": False, "error": None, "log": [], "progress": "", "hw": "", "torch": ""},
    "server": {"running": False, "starting": False, "url": None, "model": None, "log": [], "error": None, "public": False},
    "download": {"busy": False, "repo": None, "line": "", "error": None, "done": None},
    "update": {"available": None, "busy": False, "status": "", "error": None, "checked": False},
}
SERVER_PROC = None
STOPPING = False
BROWSER = None
LAST_BEAT = 0.0
BYE_AT = 0.0


def push(lst: list, line: str, progress=False, cap=400):
    with LOCK:
        if progress and lst and lst[-1].startswith("\r"):
            lst[-1] = "\r" + line
        else:
            lst.append(("\r" if progress else "") + line)
        del lst[:-cap]


def cfg_path() -> Path:
    return B.BASE / "gui.json"


def cfg() -> dict:
    try:
        return json.loads(cfg_path().read_text())
    except (OSError, ValueError):
        return {}


def save_cfg(**kw):
    c = {**cfg(), **kw}
    cfg_path().parent.mkdir(parents=True, exist_ok=True)
    cfg_path().write_text(json.dumps(c))


def bg(fn, *a):
    threading.Thread(target=fn, args=a, daemon=True).start()


# ---------------- setup ----------------
def do_setup(force=False):
    st = S["setup"]
    st.update(ready=False, error=None)
    st["activity"] = time.time()

    def log(msg, progress=False):
        st["activity"] = time.time()
        push(st["log"], msg, progress)
        st["progress"] = msg.strip()[:120] if progress else (st["progress"] if st["progress"] and "%" in st["progress"] and msg.startswith("    ") else msg.strip()[:120])
    B.LOG = log
    try:
        state = B.setup(force=force)
        B.install_app()
    except BaseException as e:  # noqa: BLE001 (setup raises SystemExit on hard failures)
        st["error"] = str(e) or "Setup failed"
        push(st["log"], f"Error: {st['error']}")
        return
    st["hw"] = f"NVIDIA GPU ({state['gpu']})" if state.get("gpu") and state.get("torch") != "cpu" else "CPU"
    st["torch"] = state.get("torch", "")
    st["ready"] = True
    st["progress"] = ""


def need_ready():
    if not S["setup"]["ready"]:
        raise ApiError("Launch is still setting up.")


class ApiError(Exception):
    pass


def run_cmd(*args) -> list[str]:
    out: list[str] = []
    B.stream(B.launch_cmd(*args), lambda t, p: out.append(t), env=B.child_env())
    return out


# ---------------- models ----------------
def models():
    need_ready()
    return B.launch_json("list", "--json")


def pull(repo: str, token: str):
    d = S["download"]
    if d["busy"]:
        raise ApiError("A download is already running.")
    if not repo or "/" not in repo:
        raise ApiError("Type a Hugging Face repo id like owner/name.")
    need_ready()
    d.update(busy=True, repo=repo, line="Starting…", error=None, done=None)

    def run():
        last = [""]

        def line(t, prog):
            last[0] = t.strip()
            d["line"] = t.strip()[:160]
        code = B.stream(B.launch_cmd("pull", repo, *(["--token", token] if token else [])), line, env=B.child_env())
        d.update(busy=False, done=repo if code == 0 else None, error=None if code == 0 else (last[0] or "Download failed"))
    bg(run)


# ---------------- server ----------------
def start_server(o: dict):
    global SERVER_PROC, STOPPING
    sv = S["server"]
    if SERVER_PROC or sv["starting"]:
        raise ApiError("The server is already running.")
    need_ready()
    model = str(o.get("model") or "").strip()
    if not model:
        raise ApiError("Download a model first, then pick it here.")
    try:
        port, ctx = int(o.get("port") or 8000), int(o.get("ctx") or 16384)
    except ValueError:
        raise ApiError("Port and context must be numbers.") from None
    public, auth = bool(o.get("public")), o.get("auth", True) is not False
    save_cfg(model=model, port=port, ctx=ctx, public=public, auth=auth)
    host = "0.0.0.0" if public else "127.0.0.1"
    args = ["serve", model, "--port", str(port), "--host", host, "--ctx", str(ctx)] + ([] if auth else ["--no-auth"])
    STOPPING = False
    sv.update(starting=True, running=False, url=None, model=model, error=None, public=public, auth=auth)
    push(sv["log"], f"$ launch {' '.join(args)}")

    def started(p):
        global SERVER_PROC
        SERVER_PROC = p

    def line(t, prog):
        push(sv["log"], t, prog)
        if "Launch API on" in t:
            sv.update(running=True, starting=False, url=f"http://127.0.0.1:{port}/v1")

    def run():
        global SERVER_PROC
        code = B.stream(B.launch_cmd(*args), line, env=B.child_env(), started=started)
        SERVER_PROC = None
        err = None if STOPPING or code == 0 else f"The server stopped (exit {code}). See the log below."
        sv.update(running=False, starting=False, url=None, error=err)
        push(sv["log"], "Server stopped." if not err else err)
    bg(run)


def stop_server():
    global STOPPING
    if SERVER_PROC:
        STOPPING = True
        SERVER_PROC.terminate()


# ---------------- chat (proxied to the local server) ----------------
def chat_key(fresh=False):
    if not S["server"].get("auth", True):
        return None
    k = cfg().get("chat_key")
    if k and not fresh:
        return k
    out = run_cmd("keys", "create", "--plan", "max", "--name", "Launch app")
    k = next((t.strip() for t in out if t.strip().startswith("sk-launch-")), None)
    if k:
        save_cfg(chat_key=k)
    return k


# ---------------- keys / accounts ----------------
def keys():
    need_ready()
    return B.launch_json("keys", "list", "--json")


def users():
    need_ready()
    return B.launch_json("users", "list", "--json")


# ---------------- updates ----------------
def check_update(manual=False):
    import updater
    u = S["update"]
    try:
        updater.cleanup()
        rel = updater.latest()
    except Exception as e:  # noqa: BLE001
        u.update(error=f"Couldn't check for updates: {e}", checked=True)
        return
    u.update(error=None, checked=True,
             available=rel if rel and updater.newer(rel["version"], B.VERSION) else None)
    u["self"] = updater.can_self_update()


def apply_update():
    import updater
    u = S["update"]
    rel = u.get("available")
    if not rel:
        raise ApiError("No update available.")
    if not updater.can_self_update():
        open_external(rel["page"])
        return
    if u["busy"]:
        return
    u.update(busy=True, status="Downloading…", error=None)

    def run():
        try:
            stop_server()
            exe = Path(sys.executable)
            new = exe.with_name(exe.stem + ".new.exe")
            updater.download(rel["url"], new, lambda pct: u.__setitem__("status", f"Downloading… {pct}%"))
            u["status"] = "Restarting…"
            updater.apply(new)
        except Exception as e:  # noqa: BLE001
            u.update(busy=False, error=f"The update didn't work: {e}", status="")
            return
        time.sleep(0.8)
        shutdown()
    bg(run)


# ---------------- misc ----------------
def open_external(target: str):
    if target.startswith(("http://", "https://")):
        import webbrowser
        webbrowser.open(target)
        return
    p = Path(target)
    p.mkdir(parents=True, exist_ok=True)
    if B.WIN:
        os.startfile(str(p))  # noqa: S606
    else:
        subprocess.Popen(["xdg-open", str(p)])


def state():
    with LOCK:
        s = json.loads(json.dumps(S, default=str))
    s["setup"]["log"] = s["setup"]["log"][-80:]
    s["server"]["log"] = s["server"]["log"][-200:]
    s["version"] = B.VERSION
    s["setup"]["idle"] = int(time.time() - S["setup"].get("activity", time.time()))
    s["cfg"] = {k: v for k, v in cfg().items() if k != "chat_key"}
    s["paths"] = {"base": str(B.BASE), "models": str(Path.home() / ".launch" / "models")}
    return s


def ui_log(msg: str):
    try:
        with open(B.BASE / "ui.log", "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n")
    except OSError:
        pass


def shutdown():
    stop_server()
    try:
        if BROWSER and BROWSER.poll() is None:
            BROWSER.terminate()
    except OSError:
        pass
    os._exit(0)


# ---------------- HTTP ----------------
class Handler(BaseHTTPRequestHandler):
    server_version = "Launch"

    def log_message(self, *a):
        pass

    def _ok_host(self):
        return self.headers.get("Host", "") in (f"127.0.0.1:{PORT}", f"localhost:{PORT}")

    def _send(self, code, body=b"", ctype="application/json"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._ok_host():
            return self._send(403, {"error": "forbidden"})
        path, _, query = self.path.partition("?")
        if path in ("/", "/index.html"):
            if f"t={TOKEN}" not in query:
                return self._send(403, "Open Launch from Launch.exe.", "text/plain")
            html = (ROOT / "webui" / "index.html").read_text(encoding="utf-8").replace("__TOKEN__", TOKEN)
            return self._send(200, html, "text/html; charset=utf-8")
        if path == "/icon.png":
            return self._send(200, (ROOT / "assets" / "icon.png").read_bytes(), "image/png")
        if path.startswith("/api/"):
            return self.api("GET", path, {})
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._ok_host():
            return self._send(403, {"error": "forbidden"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            body = {}
        if self.path == "/api/bye":  # sent by the page as it closes (sendBeacon can't add headers)
            global BYE_AT
            if body.get("t") == TOKEN:
                BYE_AT = time.time()
            return self._send(204)
        self.api("POST", self.path, body)

    def api(self, method, path, body):
        global LAST_BEAT, BYE_AT
        if self.headers.get("X-Launch-Token") != TOKEN:
            return self._send(403, {"error": "forbidden"})
        try:
            if path == "/api/state":
                LAST_BEAT, BYE_AT = time.time(), 0
                return self._send(200, state())
            if path == "/api/models":
                return self._send(200, models())
            if path == "/api/keys":
                return self._send(200, keys())
            if path == "/api/users":
                return self._send(200, users())
            if method != "POST":
                return self._send(404, {"error": "not found"})
            if path == "/api/pull":
                pull(str(body.get("repo", "")).strip(), str(body.get("token", "")).strip())
            elif path == "/api/models/delete":
                need_ready()
                if S["server"]["model"] == body.get("id") and SERVER_PROC:
                    raise ApiError("Stop the server before deleting the model it's using.")
                run_cmd("rm", str(body.get("id", "")))
            elif path == "/api/server/start":
                start_server(body)
            elif path == "/api/server/stop":
                stop_server()
            elif path == "/api/keys/create":
                need_ready()
                name, plan = str(body.get("name", "")).strip(), "max" if body.get("plan") == "max" else "free"
                out = run_cmd("keys", "create", "--plan", plan, *(["--name", name] if name else []))
                key = next((t.strip() for t in out if t.strip().startswith("sk-launch-")), None)
                if not key:
                    raise ApiError(" ".join(out) or "Couldn't create a key")
                return self._send(200, {"key": key})
            elif path == "/api/keys/action":
                need_ready()
                action = body.get("action")
                if action not in ("plan", "revoke"):
                    raise ApiError("Unknown action")
                run_cmd("keys", action, str(body.get("ref", "")), *([body["value"]] if action == "plan" and body.get("value") in ("free", "max") else []))
            elif path == "/api/users/action":
                need_ready()
                action = body.get("action")
                if action not in ("plan", "ban"):
                    raise ApiError("Unknown action")
                run_cmd("users", action, str(body.get("email", "")), *([body["value"]] if action == "plan" and body.get("value") in ("free", "max") else []))
            elif path == "/api/chat":
                return self.chat(body)
            elif path == "/api/update/check":
                check_update(True)
            elif path == "/api/update/apply":
                apply_update()
            elif path == "/api/reinstall":
                if SERVER_PROC:
                    raise ApiError("Stop the server first.")
                bg(do_setup, True)
            elif path == "/api/open":
                what = body.get("what")
                open_external({"base": str(B.BASE), "models": str(Path.home() / ".launch" / "models")}.get(what)
                              or (what if str(what).startswith("https://") else str(B.BASE)))
            elif path == "/api/copy":
                pass
            else:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"ok": True})
        except ApiError as e:
            return self._send(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self._send(500, {"error": str(e)})

    def chat(self, body, retry=True):
        url = S["server"]["url"]
        if not url:
            raise ApiError("Start the server first (Server page).")
        key = chat_key()
        payload = json.dumps({"model": S["server"]["model"], "messages": body.get("messages", []), "stream": True,
                              "stream_options": {"include_usage": True}, "max_tokens": int(body.get("max_tokens") or 2048)}).encode()
        req = urllib.request.Request(url + "/chat/completions", data=payload,
                                     headers={"content-type": "application/json", **({"authorization": f"Bearer {key}"} if key else {})})
        try:
            up = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                chat_key(fresh=True)
                return self.chat(body, retry=False)
            try:
                msg = json.loads(e.read())["error"]["message"]
            except Exception:  # noqa: BLE001
                msg = str(e)
            raise ApiError(msg) from None
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            for raw in up:
                self.wfile.write(raw)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass  # the user pressed Stop: closing the upstream cancels generation
        finally:
            up.close()
        self.close_connection = True


# ---------------- window ----------------
def find_browser() -> str | None:
    cands = []
    if B.WIN:
        for env in ("ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base:
                cands += [Path(base) / "Microsoft/Edge/Application/msedge.exe", Path(base) / "Google/Chrome/Application/chrome.exe"]
    else:
        cands += [Path(p) for p in (shutil.which("microsoft-edge") or "", shutil.which("google-chrome") or "",
                                    shutil.which("chromium") or "", "/opt/pw-browsers/chromium") if p]
    for c in cands:
        if c.is_file():
            return str(c)
    return None


def open_window(url: str):
    global BROWSER
    exe = find_browser()
    if os.environ.get("LAUNCH_NO_WINDOW"):
        print(url, flush=True)
        return
    if not exe:
        import webbrowser
        webbrowser.open(url)
        return
    prof = B.BASE / "ui-profile"
    prof.mkdir(parents=True, exist_ok=True)
    BROWSER = subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={prof}", "--no-first-run", "--no-default-browser-check",
                                "--window-size=1240,800", "--disable-features=Translate,msEdgeSidebarV2", "--disable-extensions"],
                               creationflags=B.NO_WINDOW)


def main(bootstrap_module):
    global B, PORT
    B = bootstrap_module
    srv = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("LAUNCH_UI_PORT", 0))), Handler)
    srv.daemon_threads = True
    PORT = srv.server_address[1]
    bg(srv.serve_forever)
    bg(do_setup)
    bg(check_update)
    url = f"http://127.0.0.1:{PORT}/?t={TOKEN}"
    ui_log(f"Launch {B.VERSION} started on port {PORT}")
    open_window(url)
    started = time.time()
    # Stay alive while the window is open. The page polls /api/state every second, so its heartbeat is the
    # source of truth: Edge often restarts or hands the window to another process, so its exit means nothing alone.
    reason = ""
    while True:
        time.sleep(1)
        now = time.time()
        quiet = now - (LAST_BEAT or started)
        if BYE_AT and now - BYE_AT > 4 and LAST_BEAT < BYE_AT:  # the page closed and didn't come back (a reload would)
            reason = "window closed"
            break
        edge_gone = BROWSER is not None and BROWSER.poll() is not None
        if edge_gone and LAST_BEAT and quiet > 20:  # Edge exited and the page stopped polling
            reason = "window closed (no heartbeat)"
            break
        if LAST_BEAT and quiet > 600:  # minimised windows poll slowly; give up only after 10 minutes of silence
            reason = "no heartbeat for 10 minutes"
            break
        if not LAST_BEAT and quiet > 300:
            reason = "the window never connected"
            break
    ui_log(f"closing: {reason}")
    shutdown()
