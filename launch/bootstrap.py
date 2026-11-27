"""Launch.exe — sets up Launch's private runtime on first run (Python + PyTorch for this PC), then runs it.

Double-click: a simple menu. With arguments: passes them to the launch command line,
e.g.  Launch.exe serve Qwen/Qwen2.5-Coder-7B-Instruct --port 8000
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

VERSION = "0.1.0"
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


def say(msg: str):
    print(msg, flush=True)


def download(url: str, dest: Path):
    say(f"  downloading {url.split('/')[-1]} …")
    with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, length=1 << 20)


def has_nvidia() -> str | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True, timeout=15)
        name = out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else None
        return name
    except (OSError, subprocess.SubprocessError):
        return None


def pip(*args: str):
    cmd = [str(python_exe()), "-m", "pip", "install", "--no-warn-script-location", "--disable-pip-version-check", *args]
    if subprocess.run(cmd).returncode != 0:
        raise RuntimeError("pip " + " ".join(args))


def make_python():
    if RUNTIME.exists():
        shutil.rmtree(RUNTIME)
    RUNTIME.mkdir(parents=True)
    if not WIN:  # dev/testing on Linux/macOS: a plain virtual environment
        subprocess.run([sys.executable, "-m", "venv", str(RUNTIME)], check=True)
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
    subprocess.run([str(python_exe()), str(gp), "--no-warn-script-location"], check=True)
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
        raise SystemExit("Couldn't install PyTorch. Check your internet connection and run Launch again.")
    pip(*DEPS)
    state = {"ok": True, "version": VERSION, "torch": used, "gpu": gpu}
    MARKER.write_text(json.dumps(state))
    say("\nSetup done.\n")
    return state


def run_launch(args: list[str]) -> int:
    env = {**os.environ, "PYTHONPATH": str(APP)}
    return subprocess.run([str(python_exe()), "-m", "launch", *args], env=env).returncode


def ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def menu(state: dict):
    hw = f"NVIDIA GPU ({state['gpu']})" if state.get("gpu") and state.get("torch") != "cpu" else "CPU"
    while True:
        print(f"\n  LAUNCH {VERSION}  ·  Launch engine  ·  {hw}\n")
        print("  1) Download a model from Hugging Face")
        print("  2) Start the API server (for KSTRL)")
        print("  3) Chat in this window (quick test)")
        print("  4) Downloaded models")
        print("  5) Create an API key")
        print("  6) List API keys and today's usage")
        print("  7) Reinstall the runtime")
        print("  0) Quit\n")
        c = ask("  Choose: ")
        if c == "1":
            repo = ask("  Hugging Face repo (e.g. Qwen/Qwen2.5-Coder-7B-Instruct): ")
            if repo:
                run_launch(["pull", repo])
        elif c in ("2", "3"):
            run_launch(["list"])
            model = ask("\n  Model to use (type its name): ")
            if not model:
                continue
            if c == "2":
                port = ask("  Port [8000]: ") or "8000"
                public = ask("  Allow other computers to connect? (y/N): ").lower().startswith("y")
                print("\n  Press Ctrl+C to stop the server.\n")
                try:
                    run_launch(["serve", model, "--port", port, "--host", "0.0.0.0" if public else "127.0.0.1"])
                except KeyboardInterrupt:
                    pass
            else:
                while True:
                    text = ask("\n  You (empty to go back): ")
                    if not text:
                        break
                    run_launch(["run", model, text])
        elif c == "4":
            run_launch(["list"])
        elif c == "5":
            name = ask("  Name for this key (optional): ")
            plan = "max" if ask("  MAX plan? (y/N): ").lower().startswith("y") else "free"
            run_launch(["keys", "create", "--plan", plan] + (["--name", name] if name else []))
        elif c == "6":
            run_launch(["keys", "list"])
        elif c == "7":
            setup(force=True)
        elif c in ("0", "q", "quit", "exit"):
            return


def main():
    os.system("")  # enable ANSI on Windows consoles
    try:
        state = setup()
        install_app()
        if len(sys.argv) > 1:
            sys.exit(run_launch(sys.argv[1:]))
        menu(state)
    except KeyboardInterrupt:
        pass
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"\n  Something went wrong: {e}\n")
        if len(sys.argv) <= 1:
            ask("  Press Enter to close.")
        sys.exit(1)


if __name__ == "__main__":
    main()
