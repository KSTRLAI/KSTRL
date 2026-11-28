"""Launch.exe updates from GitHub Releases (tags launch-v<version> on KSTRLAI/KSTRL)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

API = "https://api.github.com/repos/KSTRLAI/KSTRL/releases?per_page=40"
PAGE = "https://github.com/KSTRLAI/KSTRL/releases"
UA = {"User-Agent": "Launch-updater", "Accept": "application/vnd.github+json"}


def parse(v: str) -> tuple:
    return tuple(int(x) if x.isdigit() else 0 for x in v.replace("-", ".").split("."))


def newer(a: str, b: str) -> bool:
    return parse(a) > parse(b)


def latest() -> dict | None:
    """The newest Launch release: {version, url, page} (url = Launch.exe download), or None."""
    req = urllib.request.Request(API, headers=UA)
    with urllib.request.urlopen(req, timeout=20) as r:
        rels = json.load(r)
    best = None
    for rel in rels:
        tag = rel.get("tag_name", "")
        if not tag.startswith("launch-v") or rel.get("draft"):
            continue
        exe = next((a for a in rel.get("assets", []) if a.get("name") == "Launch.exe"), None)
        if not exe:
            continue
        v = tag[len("launch-v"):]
        if best is None or newer(v, best["version"]):
            best = {"version": v, "url": exe["browser_download_url"], "page": rel.get("html_url", PAGE), "size": exe.get("size", 0)}
    return best


def can_self_update() -> bool:
    return os.name == "nt" and bool(getattr(sys, "frozen", False))


def download(url: str, dest: Path, progress=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA["User-Agent"]})
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            b = r.read(1 << 18)
            if not b:
                break
            f.write(b)
            done += len(b)
            if progress and total:
                progress(done * 100 // total)
    if total and done != total:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("The download was incomplete. Try again.")
    tmp.replace(dest)


def apply(new_exe: Path):
    """Swap in the new Launch.exe and start it. Windows lets a running exe be renamed, not overwritten."""
    exe = Path(sys.executable)
    old = exe.with_name(exe.stem + ".old.exe")
    try:
        old.unlink(missing_ok=True)
    except OSError:
        old = exe.with_name(exe.stem + f".old{os.getpid()}.exe")
    exe.rename(old)
    try:
        new_exe.replace(exe)
    except OSError:
        old.rename(exe)  # put the working version back
        raise
    # PYINSTALLER_RESET_ENVIRONMENT: start the new exe as a fresh app, not as a child sharing this one's unpacked files.
    env = {**os.environ, "PYINSTALLER_RESET_ENVIRONMENT": "1"}
    subprocess.Popen([str(exe)], close_fds=True, env=env, creationflags=0x00000008 | 0x00000200)  # DETACHED_PROCESS | NEW_PROCESS_GROUP


def cleanup():
    """Remove the previous version left behind by an update."""
    if not can_self_update():
        return
    exe = Path(sys.executable)
    for p in exe.parent.glob(exe.stem + ".old*.exe"):
        try:
            p.unlink()
        except OSError:
            pass
    try:
        (exe.with_name(exe.stem + ".new.exe")).unlink(missing_ok=True)
    except OSError:
        pass
