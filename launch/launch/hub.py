"""Download models from Hugging Face into ~/.launch/models/<owner>--<name>."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

from .store import HOME

MODELS = HOME / "models"
FILES = ["*.safetensors", "*.json", "tokenizer.model", "*.txt", "*.jinja"]


def local_dir(repo: str) -> Path:
    return MODELS / repo.replace("/", "--")


def pull(repo: str, token: str | None = None) -> Path:
    from huggingface_hub import snapshot_download
    dest = local_dir(repo)
    dest.mkdir(parents=True, exist_ok=True)
    try:
        snapshot_download(repo_id=repo, local_dir=str(dest), allow_patterns=FILES, token=token)
    except Exception as e:  # noqa: BLE001
        name = type(e).__name__
        if name in ("GatedRepoError",) or "gated" in str(e).lower() or "401" in str(e):
            raise RuntimeError(f"{repo} is a gated model. Open https://huggingface.co/{repo} , accept the license, "
                               "then create a Read token at https://huggingface.co/settings/tokens and paste it in the HF token box.") from None
        if name == "RepositoryNotFoundError" or "404" in str(e):
            raise RuntimeError(f"Couldn't find {repo} on Hugging Face. Check the spelling (owner/name).") from None
        raise
    cfg = json.loads((dest / "config.json").read_text())
    if not list(dest.glob("*.safetensors")):
        raise RuntimeError(f"{repo} has no .safetensors weights. Pick a repo that ships safetensors (most do).")
    if cfg.get("quantization_config"):
        print("Warning: this is a pre-quantized checkpoint; the Launch engine needs the full-precision version.")
    return dest


def installed() -> list[dict]:
    out = []
    if MODELS.exists():
        for d in sorted(MODELS.iterdir()):
            if (d / "config.json").exists():
                size = sum(f.stat().st_size for f in d.glob("*.safetensors"))
                cfg = json.loads((d / "config.json").read_text())
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
