"""The Launch window: models, API server, chat, API keys and accounts. Plain Tk — function first, looks later."""
from __future__ import annotations

import json
import queue
import sys
import threading
import time
import tkinter as tk
import urllib.error
import urllib.request
from pathlib import Path
from tkinter import messagebox, simpledialog, ttk

SUGGESTED = [
    "Qwen/Qwen2.5-Coder-1.5B-Instruct",
    "google/gemma-3-1b-it",
    "unsloth/gemma-3-1b-it",
    "Qwen/Qwen2.5-Coder-7B-Instruct",
    "Qwen/Qwen3-4B",
    "Qwen/Qwen3-8B",
    "meta-llama/Llama-3.2-3B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
]


class App:
    def __init__(self, b):
        self.b = b  # the bootstrap module (setup, stream, launch_cmd, …)
        self.q: queue.Queue = queue.Queue()
        self.server = None  # Popen of `launch serve`
        self.server_url = None
        self.server_auth = True
        self._stopping = False
        self.chat_msgs: list[dict] = []
        self.chat_cancel = threading.Event()
        self.busy_download = False
        self.cfg_path = b.BASE / "gui.json"

        self.root = r = tk.Tk()
        r.title(f"Launch {b.VERSION}")
        r.geometry("980x660")
        r.minsize(760, 480)
        self.set_icon()
        r.protocol("WM_DELETE_WINDOW", self.close)

        top = ttk.Frame(r, padding=(10, 8))
        top.pack(fill="x")
        ttk.Label(top, text="LAUNCH", font=("Segoe UI", 14, "bold")).pack(side="left")
        ttk.Label(top, text="  Launch engine").pack(side="left")
        self.status = tk.StringVar(value="Starting…")
        ttk.Label(top, textvariable=self.status).pack(side="right")

        self.nb = nb = ttk.Notebook(r)
        nb.pack(fill="both", expand=True, padx=8, pady=(0, 8))
        self.tab_models = self.build_models(nb)
        self.tab_server = self.build_server(nb)
        self.tab_chat = self.build_chat(nb)
        self.tab_keys = self.build_keys(nb)
        self.tab_users = self.build_users(nb)
        self.tab_setup = self.build_setup(nb)
        for t, name in ((self.tab_models, "Models"), (self.tab_server, "Server"), (self.tab_chat, "Chat"),
                        (self.tab_keys, "API keys"), (self.tab_users, "Accounts"), (self.tab_setup, "Setup / log")):
            nb.add(t, text=name)

        b.LOG = lambda msg, progress=False: self.ui(self.log, msg, progress)
        r.after(50, self.pump)
        self.ready = False
        self.bg(self.do_setup)

    # ---------- plumbing ----------
    def set_icon(self):
        root = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
        try:
            if self.b.WIN and (root / "assets" / "icon.ico").exists():
                self.root.iconbitmap(str(root / "assets" / "icon.ico"))
            elif (root / "assets" / "icon.png").exists():
                self.root.iconphoto(True, tk.PhotoImage(file=str(root / "assets" / "icon.png")))
        except tk.TclError:
            pass

    def ui(self, fn, *a):
        self.q.put((fn, a))

    def pump(self):
        try:
            while True:
                fn, a = self.q.get_nowait()
                fn(*a)
        except queue.Empty:
            pass
        self.root.after(50, self.pump)

    def bg(self, fn, *a):
        def run():
            try:
                fn(*a)
            except Exception as e:  # noqa: BLE001
                self.ui(self.log, f"Error: {e}")
                self.ui(messagebox.showerror, "Launch", str(e))
        threading.Thread(target=run, daemon=True).start()

    def cfg(self) -> dict:
        try:
            return json.loads(self.cfg_path.read_text())
        except (OSError, ValueError):
            return {}

    def save_cfg(self, **kw):
        c = {**self.cfg(), **kw}
        self.cfg_path.parent.mkdir(parents=True, exist_ok=True)
        self.cfg_path.write_text(json.dumps(c))

    @staticmethod
    def text_box(parent, height=10):
        f = ttk.Frame(parent)
        t = tk.Text(f, height=height, wrap="word", font=("Consolas", 10), state="disabled")
        sb = ttk.Scrollbar(f, command=t.yview)
        t.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        t.pack(side="left", fill="both", expand=True)
        return f, t

    @staticmethod
    def append(t: tk.Text, s: str, replace_last=False):
        t.configure(state="normal")
        if replace_last:
            t.delete("end-1l linestart", "end-1c")
        t.insert("end", s)
        t.see("end")
        t.configure(state="disabled")

    def log(self, msg: str, progress=False):
        last = getattr(self, "_log_progress", False)
        self.append(self.setup_log, msg if (progress and last) else ("\n" + msg if self.setup_log.index("end-1c") != "1.0" else msg), replace_last=progress and last)
        self._log_progress = progress
        if progress:
            self.status.set(msg.strip()[:90])

    # ---------- setup ----------
    def do_setup(self):
        self.ui(self.status.set, "Checking the runtime…")
        state = self.b.setup()
        self.b.install_app()
        hw = f"NVIDIA GPU ({state['gpu']})" if state.get("gpu") and state.get("torch") != "cpu" else "CPU"
        self.ui(self.setup_info.set, f"Runtime ready · PyTorch {state.get('torch', '?')} · {hw}\nFiles: {self.b.BASE}")
        self.ready = True
        self.ui(self.status.set, f"Ready · {hw}")
        self.refresh_models()
        self.refresh_keys()
        self.refresh_users()

    def build_setup(self, nb):
        f = ttk.Frame(nb, padding=10)
        self.setup_info = tk.StringVar(value="Setting up… the first run downloads Python and PyTorch.")
        ttk.Label(f, textvariable=self.setup_info, justify="left").pack(anchor="w")
        row = ttk.Frame(f)
        row.pack(fill="x", pady=6)
        ttk.Button(row, text="Reinstall runtime", command=self.reinstall).pack(side="left")
        ttk.Button(row, text="Open Launch folder", command=lambda: self.open_path(self.b.BASE)).pack(side="left", padx=6)
        ttk.Button(row, text="Open models folder", command=lambda: self.open_path(Path.home() / ".launch" / "models")).pack(side="left")
        box, self.setup_log = self.text_box(f, 20)
        box.pack(fill="both", expand=True)
        return f

    def reinstall(self):
        if self.server:
            messagebox.showinfo("Launch", "Stop the server first.")
            return
        if messagebox.askyesno("Launch", "Download and reinstall Python and PyTorch?"):
            self.ready = False
            self.nb.select(self.tab_setup)
            self.bg(lambda: (self.b.setup(force=True), self.do_setup()))

    def open_path(self, p: Path):
        p.mkdir(parents=True, exist_ok=True)
        import os
        import subprocess
        if self.b.WIN:
            os.startfile(str(p))  # noqa: S606
        else:
            subprocess.Popen(["xdg-open", str(p)])

    def need_ready(self) -> bool:
        if not self.ready:
            messagebox.showinfo("Launch", "Launch is still setting up — see the Setup / log tab.")
        return self.ready

    # ---------- models ----------
    def build_models(self, nb):
        f = ttk.Frame(nb, padding=10)
        ttk.Label(f, text="Download a model from Hugging Face (repo id, e.g. Qwen/Qwen2.5-Coder-7B-Instruct). Supported: Llama, Mistral, Qwen2, Qwen3, Gemma 1/2/3 (text).").pack(anchor="w")
        row = ttk.Frame(f)
        row.pack(fill="x", pady=6)
        self.repo = tk.StringVar()
        ttk.Combobox(row, textvariable=self.repo, values=SUGGESTED, width=50).pack(side="left")
        self.dl_btn = ttk.Button(row, text="Download", command=self.download)
        self.dl_btn.pack(side="left", padx=6)
        ttk.Label(row, text="HF token (only for gated models):").pack(side="left", padx=(12, 4))
        self.hf_token = tk.StringVar()
        ttk.Entry(row, textvariable=self.hf_token, show="•", width=18).pack(side="left")
        self.dl_status = tk.StringVar()
        ttk.Label(f, textvariable=self.dl_status).pack(anchor="w")

        ttk.Label(f, text="Downloaded models").pack(anchor="w", pady=(10, 2))
        self.models_tv = tv = ttk.Treeview(f, columns=("arch", "gb"), height=12)
        tv.heading("#0", text="Model")
        tv.heading("arch", text="Type")
        tv.heading("gb", text="Size (GB)")
        tv.column("#0", width=480)
        tv.column("arch", width=100)
        tv.column("gb", width=100, anchor="e")
        tv.pack(fill="both", expand=True)
        row = ttk.Frame(f)
        row.pack(fill="x", pady=6)
        ttk.Button(row, text="Refresh", command=lambda: self.bg(self.refresh_models)).pack(side="left")
        ttk.Button(row, text="Use for server", command=self.use_selected).pack(side="left", padx=6)
        ttk.Button(row, text="Delete", command=self.delete_model).pack(side="left")
        return f

    def refresh_models(self):
        if not self.ready:
            return
        ms = self.b.launch_json("list", "--json")
        def show():
            self.models_tv.delete(*self.models_tv.get_children())
            for m in ms:
                self.models_tv.insert("", "end", iid=m["id"], text=m["id"], values=(m["arch"], m["gb"]))
            ids = [m["id"] for m in ms]
            self.server_model["values"] = ids
            if ids and self.model_var.get() not in ids:
                self.model_var.set(self.cfg().get("model") if self.cfg().get("model") in ids else ids[0])
        self.ui(show)

    def download(self):
        repo = self.repo.get().strip()
        if not repo or "/" not in repo:
            messagebox.showinfo("Launch", "Type a Hugging Face repo id like owner/name.")
            return
        if not self.need_ready() or self.busy_download:
            return
        self.busy_download = True
        self.dl_btn.configure(state="disabled")
        args = ["pull", repo] + (["--token", self.hf_token.get().strip()] if self.hf_token.get().strip() else [])

        def run():
            self.ui(self.dl_status.set, f"Downloading {repo}…")
            last = [""]
            def line(t, prog):
                last[0] = t
                self.ui(self.dl_status.set, t.strip()[:140])
                if not prog:
                    self.ui(self.log, t)
            code = self.b.stream(self.b.launch_cmd(*args), line, env=self.b.child_env())
            self.busy_download = False
            self.ui(self.dl_btn.configure, {"state": "normal"})
            self.ui(self.dl_status.set, f"Downloaded {repo}." if code == 0 else f"Download failed: {last[0]}")
            self.refresh_models()
        self.bg(run)

    def use_selected(self):
        sel = self.models_tv.selection()
        if sel:
            self.model_var.set(sel[0])
            self.nb.select(self.tab_server)

    def delete_model(self):
        sel = self.models_tv.selection()
        if not sel or not self.need_ready():
            return
        if self.server and self.model_var.get() == sel[0]:
            messagebox.showinfo("Launch", "Stop the server before deleting the model it's using.")
            return
        if messagebox.askyesno("Launch", f"Delete {sel[0]} from this PC?"):
            self.bg(lambda: (self.b.stream(self.b.launch_cmd("rm", sel[0]), lambda t, p: self.ui(self.log, t), env=self.b.child_env()), self.refresh_models()))

    # ---------- server ----------
    def build_server(self, nb):
        f = ttk.Frame(nb, padding=10)
        c = self.cfg()
        g = ttk.Frame(f)
        g.pack(fill="x")
        self.model_var = tk.StringVar(value=c.get("model", ""))
        self.port_var = tk.StringVar(value=str(c.get("port", 8000)))
        self.ctx_var = tk.StringVar(value=str(c.get("ctx", 16384)))
        self.public_var = tk.BooleanVar(value=c.get("public", False))
        self.auth_var = tk.BooleanVar(value=c.get("auth", True))
        ttk.Label(g, text="Model").grid(row=0, column=0, sticky="w", pady=3)
        self.server_model = ttk.Combobox(g, textvariable=self.model_var, width=50, state="readonly")
        self.server_model.grid(row=0, column=1, sticky="w")
        ttk.Label(g, text="Port").grid(row=1, column=0, sticky="w", pady=3)
        ttk.Entry(g, textvariable=self.port_var, width=8).grid(row=1, column=1, sticky="w")
        ttk.Label(g, text="Context (tokens)").grid(row=2, column=0, sticky="w", pady=3)
        ttk.Combobox(g, textvariable=self.ctx_var, values=["8192", "12288", "16384", "32768"], width=8).grid(row=2, column=1, sticky="w")
        ttk.Checkbutton(g, text="Allow other devices on the network / internet to connect", variable=self.public_var).grid(row=3, column=1, sticky="w")
        ttk.Checkbutton(g, text="Require API keys (KSTRL gets one automatically)", variable=self.auth_var).grid(row=4, column=1, sticky="w")
        for i in range(5):
            g.grid_rowconfigure(i, pad=2)
        g.grid_columnconfigure(0, minsize=130)

        row = ttk.Frame(f)
        row.pack(fill="x", pady=8)
        self.srv_btn = ttk.Button(row, text="Start server", command=self.toggle_server)
        self.srv_btn.pack(side="left")
        self.srv_state = tk.StringVar(value="Stopped")
        ttk.Label(row, textvariable=self.srv_state).pack(side="left", padx=10)
        ttk.Button(row, text="Copy API URL", command=self.copy_url).pack(side="right")
        ttk.Label(f, text="In KSTRL: Settings → Model Server → paste the API URL (it ends in /v1). KSTRL creates its own key.", foreground="#666").pack(anchor="w")
        box, self.server_log = self.text_box(f, 16)
        box.pack(fill="both", expand=True, pady=(6, 0))
        return f

    def copy_url(self):
        url = self.server_url or f"http://127.0.0.1:{self.port_var.get().strip() or 8000}/v1"
        self.root.clipboard_clear()
        self.root.clipboard_append(url)
        self.status.set(f"Copied {url}")

    def toggle_server(self):
        if self.server:
            self._stopping = True
            self.server.terminate()
            self.srv_state.set("Stopping…")
            return
        self._stopping = False
        if not self.need_ready():
            return
        model = self.model_var.get().strip()
        if not model:
            messagebox.showinfo("Launch", "Download a model first (Models tab), then pick it here.")
            return
        try:
            port = int(self.port_var.get())
            ctx = int(self.ctx_var.get())
        except ValueError:
            messagebox.showerror("Launch", "Port and context must be numbers.")
            return
        host = "0.0.0.0" if self.public_var.get() else "127.0.0.1"
        self.save_cfg(model=model, port=port, ctx=ctx, public=self.public_var.get(), auth=self.auth_var.get())
        args = ["serve", model, "--port", str(port), "--host", host, "--ctx", str(ctx)] + ([] if self.auth_var.get() else ["--no-auth"])
        self.server_auth = self.auth_var.get()
        self.srv_btn.configure(text="Stop server")
        self.srv_state.set(f"Loading {model}…")
        self.append(self.server_log, f"\n$ launch {' '.join(args)}\n")

        def started(p):
            self.server = p

        def line(t, prog):
            self.ui(self.append, self.server_log, t + "\n")
            if "Launch API on" in t:
                self.server_url = f"http://127.0.0.1:{port}/v1"
                self.ui(self.srv_state.set, f"Running · {self.server_url}" + (" (also on your network)" if host == "0.0.0.0" else ""))
                self.ui(self.status.set, f"Server running: {model}")

        def run():
            code = self.b.stream(self.b.launch_cmd(*args), line, env=self.b.child_env(), started=started)
            self.server = None
            self.server_url = None
            self.ui(self.srv_btn.configure, {"text": "Start server"})
            self.ui(self.srv_state.set, "Stopped" if self._stopping or code == 0 else f"Stopped (exit {code}) — see the log above")
            self.ui(self.status.set, "Server stopped")
        self.bg(run)

    # ---------- chat ----------
    def build_chat(self, nb):
        f = ttk.Frame(nb, padding=10)
        ttk.Label(f, text="Chat with the model the server is running (start it in the Server tab).", foreground="#666").pack(anchor="w")
        box, self.chat_box = self.text_box(f, 18)
        box.pack(fill="both", expand=True, pady=6)
        self.chat_box.tag_configure("you", foreground="#2563eb", font=("Segoe UI", 10, "bold"))
        self.chat_box.tag_configure("ai", foreground="#b91c1c", font=("Segoe UI", 10, "bold"))
        row = ttk.Frame(f)
        row.pack(fill="x")
        self.chat_in = tk.Text(row, height=3, wrap="word", font=("Segoe UI", 10))
        self.chat_in.pack(side="left", fill="x", expand=True)
        self.chat_in.bind("<Return>", lambda e: (self.send_chat(), "break")[1] if not (e.state & 1) else None)
        col = ttk.Frame(row)
        col.pack(side="left", padx=(6, 0))
        self.send_btn = ttk.Button(col, text="Send", command=self.send_chat)
        self.send_btn.pack(fill="x")
        ttk.Button(col, text="Stop", command=self.chat_cancel.set).pack(fill="x", pady=2)
        ttk.Button(col, text="Clear", command=self.clear_chat).pack(fill="x")
        self.chat_stats = tk.StringVar()
        ttk.Label(f, textvariable=self.chat_stats, foreground="#666").pack(anchor="w")
        return f

    def clear_chat(self):
        self.chat_msgs = []
        self.chat_box.configure(state="normal")
        self.chat_box.delete("1.0", "end")
        self.chat_box.configure(state="disabled")

    def chat_key(self, fresh=False) -> str | None:
        if not self.server_auth:
            return None
        k = self.cfg().get("chat_key")
        if k and not fresh:
            return k
        out = []
        self.b.stream(self.b.launch_cmd("keys", "create", "--plan", "max", "--name", "Launch app"), lambda t, p: out.append(t), env=self.b.child_env())
        k = next((t.strip() for t in out if t.strip().startswith("sk-launch-")), None)
        if k:
            self.save_cfg(chat_key=k)
        return k

    def send_chat(self):
        text = self.chat_in.get("1.0", "end").strip()
        if not text or self.send_btn["state"] == "disabled":
            return
        if not self.server_url:
            messagebox.showinfo("Launch", "Start the server first (Server tab) — wait until it says Running.")
            return
        self.chat_in.delete("1.0", "end")
        self.chat_msgs.append({"role": "user", "content": text})
        self.chat_box.configure(state="normal")
        self.chat_box.insert("end", ("\n\n" if self.chat_box.index("end-1c") != "1.0" else "") + "You\n", "you")
        self.chat_box.insert("end", text + "\n\n")
        self.chat_box.insert("end", "Launch\n", "ai")
        self.chat_box.see("end")
        self.chat_box.configure(state="disabled")
        self.send_btn.configure(state="disabled")
        self.chat_cancel.clear()
        self.bg(self.stream_chat, self.server_url)

    def stream_chat(self, url, retry=True):
        key = self.chat_key()
        body = json.dumps({"model": self.model_var.get(), "messages": self.chat_msgs, "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 2048}).encode()
        req = urllib.request.Request(url + "/chat/completions", data=body, headers={"content-type": "application/json", **({"authorization": f"Bearer {key}"} if key else {})})
        reply, t0, n = "", time.time(), 0
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                for raw in r:
                    if self.chat_cancel.is_set():
                        break
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:") or line == "data: [DONE]":
                        continue
                    ev = json.loads(line[5:])
                    if ev.get("error"):
                        raise RuntimeError(ev["error"].get("message", "engine error"))
                    if ev.get("usage"):
                        n = ev["usage"].get("completion_tokens", 0)
                    for ch in ev.get("choices", []):
                        d = ch.get("delta", {}).get("content")
                        if d:
                            reply += d
                            self.ui(self.append, self.chat_box, d)
        except urllib.error.HTTPError as e:
            if e.code == 401 and retry:
                self.chat_key(fresh=True)
                return self.stream_chat(url, retry=False)
            try:
                msg = json.loads(e.read())["error"]["message"]
            except Exception:  # noqa: BLE001
                msg = str(e)
            self.ui(self.append, self.chat_box, f"[error: {msg}]")
        except Exception as e:  # noqa: BLE001
            self.ui(self.append, self.chat_box, f"[error: {e}]")
        finally:
            if reply:
                self.chat_msgs.append({"role": "assistant", "content": reply})
            elif self.chat_msgs and self.chat_msgs[-1]["role"] == "user":
                self.chat_msgs.pop()
            dt = max(1e-6, time.time() - t0)
            self.ui(self.chat_stats.set, f"{n} tokens · {n / dt:.1f} tok/s" if n else "")
            self.ui(self.send_btn.configure, {"state": "normal"})

    # ---------- keys ----------
    def build_keys(self, nb):
        f = ttk.Frame(nb, padding=10)
        ttk.Label(f, text="API keys. KSTRL installs get one automatically; make one here for other apps. Launch only stores a hash of each key.", foreground="#666").pack(anchor="w")
        self.keys_tv = tv = ttk.Treeview(f, columns=("plan", "state", "used", "who"), height=14)
        for col, name, w in (("#0", "Key", 170), ("plan", "Plan", 60), ("state", "State", 80), ("used", "Credits today", 110), ("who", "Who", 360)):
            tv.heading(col, text=name)
            tv.column(col, width=w)
        tv.pack(fill="both", expand=True, pady=6)
        row = ttk.Frame(f)
        row.pack(fill="x")
        ttk.Button(row, text="Create key…", command=self.create_key).pack(side="left")
        ttk.Button(row, text="Make MAX", command=lambda: self.key_action("plan", "max")).pack(side="left", padx=6)
        ttk.Button(row, text="Make Free", command=lambda: self.key_action("plan", "free")).pack(side="left")
        ttk.Button(row, text="Revoke", command=lambda: self.key_action("revoke")).pack(side="left", padx=6)
        ttk.Button(row, text="Refresh", command=lambda: self.bg(self.refresh_keys)).pack(side="right")
        return f

    def refresh_keys(self):
        if not self.ready:
            return
        ks = self.b.launch_json("keys", "list", "--json")
        def show():
            self.keys_tv.delete(*self.keys_tv.get_children())
            for k in ks:
                who = k["email"] or k["name"] or ("KSTRL install (automatic)" if k["install"] else "")
                self.keys_tv.insert("", "end", iid=k["prefix"], text=k["prefix"] + "…", values=(k["plan"], k["state"], k["used"], who))
        self.ui(show)

    def create_key(self):
        if not self.need_ready():
            return
        name = simpledialog.askstring("Create API key", "Name for this key (optional):", parent=self.root)
        if name is None:
            return
        plan = "max" if messagebox.askyesno("Create API key", "Give this key the MAX plan (20× usage)?") else "free"
        out = []
        def run():
            self.b.stream(self.b.launch_cmd("keys", "create", "--plan", plan, *(["--name", name] if name else [])), lambda t, p: out.append(t), env=self.b.child_env())
            key = next((t.strip() for t in out if t.strip().startswith("sk-launch-")), None)
            self.ui(self.show_key, key or "\n".join(out))
            self.refresh_keys()
        self.bg(run)

    def show_key(self, key):
        w = tk.Toplevel(self.root)
        w.title("Your new API key")
        ttk.Label(w, text="Copy it now — Launch won't show it again.", padding=10).pack()
        v = tk.StringVar(value=key)
        e = ttk.Entry(w, textvariable=v, width=64)
        e.pack(padx=10)
        e.select_range(0, "end")
        def copy():
            self.root.clipboard_clear()
            self.root.clipboard_append(key)
            w.destroy()
        ttk.Button(w, text="Copy and close", command=copy).pack(pady=10)

    def key_action(self, action, value=None):
        sel = self.keys_tv.selection()
        if not sel or not self.need_ready():
            return
        if action == "revoke" and not messagebox.askyesno("Launch", f"Revoke {sel[0]}…? Apps using it stop working."):
            return
        args = ["keys", action, sel[0]] + ([value] if value else [])
        self.bg(lambda: (self.b.stream(self.b.launch_cmd(*args), lambda t, p: self.ui(self.log, t), env=self.b.child_env()), self.refresh_keys()))

    # ---------- accounts ----------
    def build_users(self, nb):
        f = ttk.Frame(nb, padding=10)
        ttk.Label(f, text="Accounts made with KSTRL's Sign up screen. Usage is counted per account, across all of a person's devices.", foreground="#666").pack(anchor="w")
        self.users_tv = tv = ttk.Treeview(f, columns=("name", "plan", "state", "used"), height=14)
        for col, name, w in (("#0", "Email", 280), ("name", "Name", 160), ("plan", "Plan", 60), ("state", "State", 80), ("used", "Credits today", 110)):
            tv.heading(col, text=name)
            tv.column(col, width=w)
        tv.pack(fill="both", expand=True, pady=6)
        row = ttk.Frame(f)
        row.pack(fill="x")
        ttk.Button(row, text="Make MAX", command=lambda: self.user_action("plan", "max")).pack(side="left")
        ttk.Button(row, text="Make Free", command=lambda: self.user_action("plan", "free")).pack(side="left", padx=6)
        ttk.Button(row, text="Block", command=lambda: self.user_action("ban")).pack(side="left")
        ttk.Button(row, text="Refresh", command=lambda: self.bg(self.refresh_users)).pack(side="right")
        return f

    def refresh_users(self):
        if not self.ready:
            return
        us = self.b.launch_json("users", "list", "--json")
        def show():
            self.users_tv.delete(*self.users_tv.get_children())
            for u in us:
                self.users_tv.insert("", "end", iid=u["email"], text=u["email"], values=(u["name"], u["plan"], "blocked" if u["banned"] else "active", u["used"]))
        self.ui(show)

    def user_action(self, action, value=None):
        sel = self.users_tv.selection()
        if not sel or not self.need_ready():
            return
        if action == "ban" and not messagebox.askyesno("Launch", f"Block {sel[0]}? They won't be able to log in or chat."):
            return
        args = ["users", action, sel[0]] + ([value] if value else [])
        self.bg(lambda: (self.b.stream(self.b.launch_cmd(*args), lambda t, p: self.ui(self.log, t), env=self.b.child_env()), self.refresh_users()))

    # ---------- exit ----------
    def close(self):
        if self.server and not messagebox.askyesno("Launch", "The server is running. Stop it and quit?"):
            return
        if self.server:
            self._stopping = True
            self.server.terminate()
        self.root.destroy()


def main(bootstrap_module):
    app = App(bootstrap_module)
    app.root.mainloop()
