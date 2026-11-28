"""Launch.exe — sets up Launch's private runtime on first run (Python + PyTorch for this PC), then runs it.

Double-click: the Launch window (gui.py). With arguments: passes them to the launch command line,
e.g.  Launch.exe serve Qwen/Qwen2.5-Coder-7B-Instruct --port 8000
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

VERSION = "0.4.0"
PY_VERSION = "3.12.10"
PY_EMBED = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
GET_PIP = "https://bootstrap.pypa.io/get-pip.py"
TORCH_INDEXES_GPU = ["https://download.pytorch.org/whl/cu128", "https://download.pytorch.org/whl/cu126"]
TORCH_INDEX_CPU = "https://download.pytorch.org/whl/cpu"
DEPS = ["safetensors>=0.4", "tokenizers>=0.15", "jinja2>=3.1", "fastapi>=0.110", "uvicorn>=0.29", "huggingface_hub>=0.23"]

WIN = os.name == "nt"
BASE = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "Launch"
RUNTIME = BASE / "runtime"
APP = BASE / "app"
MARKER = BASE / "runtime.json"


def bundled_src() -> Path:
    """The launch package shipped inside the exe (PyInstaller) or next to this file (dev)."""
    root = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    for p in (root / "launch_src" / "launch", root / "launch"):
        if (p / "engine.py").exists():
            return p
    raise SystemExit("The Launch files are missing from this build.")


def python_exe() -> Path:
    if os.environ.get("LAUNCH_PYTHON"):  # for testing with an existing environment
        return Path(os.environ["LAUNCH_PYTHON"])
    return RUNTIME / "python.exe" if WIN else RUNTIME / "bin" / "python"


LOG = lambda msg, progress=False: print(msg, end="\r" if progress else "\n", flush=True)  # the window replaces this
NO_WINDOW = 0x08000000 if WIN else 0  # CREATE_NO_WINDOW: child processes don't flash a console


def say(msg: str):
    LOG(msg)


def child_env() -> dict:
    return {**os.environ, "PYTHONPATH": str(APP), "PYTHONUNBUFFERED": "1", "PYTHONIOENCODING": "utf-8"}


def stream(cmd: list[str], on_line=None, env=None, started=None) -> int:
    """Run a command, passing each output line to on_line(text, progress). Progress-bar redraws (\\r) have progress=True."""
    on_line = on_line or LOG
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, creationflags=NO_WINDOW)
    if started:
        started(p)
    buf = b""
    while True:
        chunk = p.stdout.read1(4096) if hasattr(p.stdout, "read1") else p.stdout.read(1)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"(\r\n|\r|\n)", buf)
        buf = parts.pop()
        for text, sep in zip(parts[0::2], parts[1::2]):
            t = text.decode("utf-8", "replace").rstrip()
            if t.strip():
                on_line(t, sep == b"\r")
    if buf.strip():
        on_line(buf.decode("utf-8", "replace").rstrip(), False)
    return p.wait()


def launch_cmd(*args: str) -> list[str]:
    return [str(python_exe()), "-m", "launch", *args]


def launch_json(*args: str):
    """Run a launch command that prints JSON and return the parsed result."""
    out = subprocess.run(launch_cmd(*args), capture_output=True, text=True, env=child_env(), creationflags=NO_WINDOW, timeout=120)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip().splitlines()[-1] if (out.stderr or out.stdout).strip() else "failed")
    return json.loads(out.stdout.strip().splitlines()[-1])


def download(url: str, dest: Path):
    say(f"  downloading {url.split('/')[-1]} …")
    with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            done += len(b)
            if total:
                LOG(f"  {done * 100 // total}% of {total / 1e6:.0f} MB", True)


def has_nvidia() -> str | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=15, creationflags=NO_WINDOW)
        name = out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
        return name
    except (OSError, subprocess.SubprocessError):
        return None


def pip(*args: str):
    cmd = [str(python_exe()), "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", *args]
    if stream(cmd, lambda t, prog: LOG("    " + t.strip(), prog)) != 0:
        raise RuntimeError("pip " + " ".join(args))


def make_python():
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    RUNTIME.mkdir(parents=True)
    if not WIN:  # dev/testing on Linux/macOS: a plain virtual environment
        subprocess.run([sys.executable if not getattr(sys, "frozen", False) else "python3", "-m", "venv", str(RUNTIME)], check=True)
        return
    z = BASE / "python-embed.zip"
    download(PY_EMBED, z)
    with zipfile.ZipFile(z) as f:
        f.extractall(RUNTIME)
    z.unlink()
    pth = next(RUNTIME.glob("python3*._pth"))
    pth.write_text(f"{pth.stem}.zip\n.\nLib\\site-packages\n{APP}\nimport site\n")
    gp = BASE / "get-pip.py"
    download(GET_PIP, gp)
    if stream([str(python_exe()), str(gp), "--no-warn-script-location"], lambda t, prog: LOG("    " + t.strip(), prog)) != 0:
        raise RuntimeError("Couldn't install pip")
    gp.unlink()


def install_app():
    """Copy this exe's version of the Launch code into the runtime (every run, so updates apply)."""
    dest = APP / "launch"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(bundled_src(), dest, ignore=shutil.ignore_patterns("__pycache__"))


def setup(force: bool = False):
    state = json.loads(MARKER.read_text()) if MARKER.exists() else {}
    if not force and state.get("ok") and python_exe().exists():
        return state
    BASE.mkdir(parents=True, exist_ok=True)
    gpu = has_nvidia()
    say("\nSetting up Launch (first run only). This downloads Python and PyTorch — about "
        + ("2.5 GB for your NVIDIA GPU" if gpu else "250 MB") + ".\n")
    if gpu:
        say(f"  NVIDIA GPU found: {gpu}")
    if not os.environ.get("LAUNCH_PYTHON"):
        make_python()
    torch_ok = False
    for index in (TORCH_INDEXES_GPU if gpu else []) + [TORCH_INDEX_CPU]:
        try:
            say(f"  installing PyTorch ({index.rsplit('/', 1)[-1]}) …")
            pip("torch", "--index-url", index)
            torch_ok = True
            used = index.rsplit("/", 1)[-1]
            break
        except RuntimeError:
            say("  that didn't work, trying the next option…")
    if not torch_ok:
        raise RuntimeError("Couldn't install PyTorch. Check your internet connection and run Launch again.")
    pip(*DEPS)
    state = {"ok": True, "version": VERSION, "torch": used, "gpu": gpu}
    MARKER.write_text(json.dumps(state))
    say("\nSetup done.\n")
    return state


def run_launch(args: list[str]) -> int:
    """Command-line mode: run launch and print its output to the console Launch.exe was started from."""
    return stream(launch_cmd(*args), lambda t, prog: print(t, end="\r" if prog else "\n", flush=True), env=child_env())


def attach_console():
    """Launch.exe is a window app; when it's run from a terminal with arguments, print to that terminal."""
    if WIN and (sys.stdout is None or not sys.stdout.isatty()):
        import ctypes
        if ctypes.windll.kernel32.AttachConsole(-1):
            sys.stdout = sys.stderr = open("CONOUT$", "w", encoding="utf-8", buffering=1)
    if sys.stdout is None:  # no terminal at all
        sys.stdout = sys.stderr = open(os.devnull, "w")


def main():
    if len(sys.argv) > 1:
        attach_console()
        if sys.argv[1] in ("--version", "-V"):
            print(f"Launch {VERSION}")
            return
        try:
            setup()
            install_app()
            sys.exit(run_launch(sys.argv[1:]))
        except KeyboardInterrupt:
            pass
        except Exception as e:  # noqa: BLE001
            print(f"Something went wrong: {e}")
            sys.exit(1)
        return
    if os.environ.get("LAUNCH_CLASSIC"):  # the old Tk window, kept as a fallback
        import gui
        gui.main(sys.modules[__name__])
        return
    import webui
    webui.main(sys.modules[__name__])


if __name__ == "__main__":
    main()
