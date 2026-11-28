"""Download models from Hugging Face into ~/.launch/models/<owner>--<name>.

Launch's own downloader (plain HTTPS, no huggingface_hub): it lists the repo's files with the Hub API,
fetches the ones the engine needs with resume and retries, and prints progress lines like
  Downloading 42% · 1.10 / 2.61 GB · model-00001-of-00002.safetensors
"""
from __future__ import annotations

import fnmatch
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .store import HOME

MODELS = HOME / "models"
ENDPOINT = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
META = ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
        "tokenizer.model", "chat_template.jinja", "chat_template.json", "vocab.json", "merges.txt", "*.safetensors.index.json",
        "pytorch_model.bin.index.json"]
UA = "Launch/1.0"


class HubError(RuntimeError):
    pass


def local_dir(repo: str) -> Path:
    return MODELS / repo.replace("/", "--")


def _req(url: str, token: str | None, extra: dict | None = None) -> urllib.request.Request:
    h = {"User-Agent": UA, **(extra or {})}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=h)


def _explain(code: int, repo: str, token: str | None) -> str:
    if code in (401, 403):
        return (f"{repo} is gated or private. Open https://huggingface.co/{repo} , accept the license, then create a Read token at "
                "https://huggingface.co/settings/tokens and paste it in the Hugging Face token box." if not token else
                f"Hugging Face refused the download ({code}). Make sure you accepted the license on https://huggingface.co/{repo} "
                "with the same account as your token, and that the token has Read access.")
    if code == 404:
        return f"Couldn't find {repo} on Hugging Face. Check the spelling (owner/name) — it's case-sensitive."
    if code == 429:
        return "Hugging Face is rate-limiting downloads. Wait a minute and try again (a token raises the limit)."
    return f"Hugging Face returned an error ({code})."


def list_files(repo: str, token: str | None) -> list[dict]:
    url = f"{ENDPOINT}/api/models/{urllib.parse.quote(repo, safe='/')}?blobs=true"
    try:
        with urllib.request.urlopen(_req(url, token), timeout=30) as r:
            info = json.load(r)
    except urllib.error.HTTPError as e:
        raise HubError(_explain(e.code, repo, token)) from None
    except urllib.error.URLError as e:
        raise HubError(f"Couldn't reach Hugging Face ({e.reason}). Check your internet connection.") from None
    return [{"name": s["rfilename"], "size": int(s.get("size") or (s.get("lfs") or {}).get("size") or 0)} for s in info.get("siblings", [])]


def pick(files: list[dict]) -> list[dict]:
    """The files the engine needs: config + tokenizer + weights (safetensors, else PyTorch .bin). Top level only."""
    top = [f for f in files if "/" not in f["name"]]
    keep = [f for f in top if any(fnmatch.fnmatch(f["name"], p) for p in META)]
    st = [f for f in top if f["name"].endswith(".safetensors")]
    if st:
        # some repos ship both a full model and an extra single file (e.g. consolidated.safetensors for Mistral); prefer the HF layout
        hf = [f for f in st if f["name"].startswith("model")]
        weights = hf or st
    else:
        weights = [f for f in top if fnmatch.fnmatch(f["name"], "pytorch_model*.bin")]
    return keep + weights


def _fetch(repo: str, f: dict, dest: Path, token: str | None, report):
    url = f"{ENDPOINT}/{urllib.parse.quote(repo, safe='/')}/resolve/main/{urllib.parse.quote(f['name'])}"
    part = dest.with_name(dest.name + ".part")
    for attempt in range(5):
        have = part.stat().st_size if part.exists() else 0
        try:
            req = _req(url, token, {"Range": f"bytes={have}-"} if have else None)
            with urllib.request.urlopen(req, timeout=60) as r:
                if have and r.status != 206:  # server ignored the range: start over
                    have = 0
                with open(part, "ab" if have else "wb") as out:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
                        report(len(chunk))
            if f["size"] and part.stat().st_size != f["size"]:
                raise OSError(f"incomplete ({part.stat().st_size} of {f['size']} bytes)")
            part.replace(dest)
            return
        except urllib.error.HTTPError as e:
            if e.code == 416:  # already complete
                part.replace(dest)
                return
            if e.code in (401, 403, 404):
                raise HubError(_explain(e.code, repo, token)) from None
            err = f"HTTP {e.code}"
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            err = str(getattr(e, "reason", e))
        print(f"  retrying {f['name']} ({err})…", flush=True)
        time.sleep(2 + attempt * 3)
    raise HubError(f"Downloading {f['name']} kept failing ({err}). Check your connection and try again — it resumes where it stopped.")


def pull(repo: str, token: str | None = None) -> Path:
    repo = repo.strip().strip("/")
    if repo.startswith("https://huggingface.co/"):
        repo = repo[len("https://huggingface.co/"):].split("/tree/")[0].strip("/")
    if repo.count("/") != 1:
        raise HubError("Use the repo id, like Qwen/Qwen2.5-Coder-7B-Instruct.")
    print(f"Looking up {repo} on Hugging Face…", flush=True)
    files = list_files(repo, token)
    names = [f["name"] for f in files]
    if any(n.lower().endswith(".gguf") for n in names) and not any(n.endswith((".safetensors", ".bin")) for n in names):
        raise HubError(f"{repo} only has GGUF files. Launch runs the original Hugging Face version — try the repo without '-GGUF' in its name.")
    want = pick(files)
    if "config.json" not in [f["name"] for f in want]:
        raise HubError(f"{repo} has no config.json, so it isn't a Transformers model Launch can run.")
    if not any(f["name"].endswith((".safetensors", ".bin")) for f in want):
        raise HubError(f"{repo} has no model weights Launch can read (.safetensors or .bin).")
    dest = local_dir(repo)
    dest.mkdir(parents=True, exist_ok=True)
    total = sum(f["size"] for f in want) or 1
    done = sum(f["size"] for f in want if (dest / f["name"]).exists() and (dest / f["name"]).stat().st_size == f["size"])
    done += sum((dest / (f["name"] + ".part")).stat().st_size for f in want if (dest / (f["name"] + ".part")).exists())
    state = {"done": done, "last": 0.0, "file": ""}

    def report(n):
        state["done"] += n
        now = time.time()
        if now - state["last"] > 0.25:
            state["last"] = now
            pct = min(100, state["done"] * 100 // total)
            print(f"Downloading {pct}% · {state['done'] / 1e9:.2f} / {total / 1e9:.2f} GB · {state['file']}", end="\r", flush=True)

    for f in sorted(want, key=lambda x: x["size"]):
        target = dest / f["name"]
        if target.exists() and (not f["size"] or target.stat().st_size == f["size"]):
            continue
        state["file"] = f["name"]
        _fetch(repo, f, target, token, report)
    print(f"Downloading 100% · {total / 1e9:.2f} / {total / 1e9:.2f} GB · done", flush=True)
    cfg = json.loads((dest / "config.json").read_text())
    if cfg.get("quantization_config"):
        print("Warning: this is a pre-quantized checkpoint; the Launch engine needs the full-precision version.", flush=True)
    return dest


def installed() -> list[dict]:
    out = []
    if MODELS.exists():
        for d in sorted(MODELS.iterdir()):
            if (d / "config.json").exists():
                size = sum(f.stat().st_size for f in d.iterdir() if f.suffix in (".safetensors", ".bin"))
                try:
                    cfg = json.loads((d / "config.json").read_text())
                except ValueError:
                    cfg = {}
                out.append({"id": d.name.replace("--", "/", 1), "path": d, "arch": cfg.get("model_type", "?"), "gb": round(size / 1e9, 2)})
    return out


def resolve(name: str) -> Path:
    """A repo id (owner/name), a folder name under ~/.launch/models, or a path."""
    p = Path(name).expanduser()
    if p.exists():
        return p
    d = local_dir(name)
    if d.exists():
        return d
    raise FileNotFoundError(f"Model '{name}' isn't downloaded. Run: launch pull {name}")


def remove(name: str):
    shutil.rmtree(resolve(name))
