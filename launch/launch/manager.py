"""Which model the server runs: loads models on demand, one at a time, and maps KSTRL's Colossus models to local ones.

The model map lives in ~/.launch/map.json: {"colossus-3": "Qwen/Qwen2.5-Coder-7B-Instruct", ...}. A request for a
Colossus model (KSTRL sends X-KSTRL-Model) runs its mapped model; a request naming a downloaded model runs that one;
anything else runs whatever is loaded, or the map's default.
"""
from __future__ import annotations

import gc
import json
import threading
import time

from .store import HOME

MAP_FILE = HOME / "map.json"
COLOSSUS = ["colossus-2.1", "colossus-2.2", "colossus-2.2-uc", "colossus-3"]


def read_map() -> dict:
    try:
        m = json.loads(MAP_FILE.read_text())
        return {k: v for k, v in m.items() if isinstance(v, str) and v}
    except (OSError, ValueError):
        return {}


def write_map(m: dict):
    MAP_FILE.parent.mkdir(parents=True, exist_ok=True)
    MAP_FILE.write_text(json.dumps({k: v for k, v in m.items() if v}, indent=2))


class Manager:
    def __init__(self, ctx: int = 16384, device: str | None = None):
        self.ctx, self.device = ctx, device
        self.engine = None
        self.fmt = None
        self.model_id: str | None = None
        self.loading: str | None = None
        self.error: str | None = None
        self.loaded_at = 0.0
        self.lock = threading.Lock()

    @staticmethod
    def installed() -> list[str]:
        from .hub import installed
        return [m["id"] for m in installed()]

    def resolve(self, requested: str | None, kstrl_model: str | None) -> str | None:
        ids = self.installed()
        if not ids:
            return None
        if requested in ids:
            return requested
        m = read_map()
        for key in (kstrl_model, requested):
            if key and m.get(key) in ids:
                return m[key]
        if self.model_id in ids:
            return self.model_id
        if m.get("default") in ids:
            return m["default"]
        for k in reversed(COLOSSUS):
            if m.get(k) in ids:
                return m[k]
        return ids[0]

    def get(self, model_id: str):
        """The engine for model_id, loading it (and unloading the previous one) if needed. Blocking."""
        with self.lock:
            if self.engine is not None and self.model_id == model_id:
                return self.engine
            self._unload()
            from .chat import ChatFormat
            from .engine import Engine
            from .hub import resolve
            self.loading, self.error = model_id, None
            t = time.time()
            print(f"Loading {model_id} with the Launch engine…", flush=True)
            try:
                eng = Engine(resolve(model_id), device=self.device, max_ctx=self.ctx, name=model_id)
            except Exception as e:  # noqa: BLE001
                self.error = f"{model_id}: {e}"
                self.loading = None
                print(f"Couldn't load {model_id}: {e}", flush=True)
                raise
            self.engine, self.fmt, self.model_id = eng, ChatFormat(eng.tok_config), model_id
            self.loading, self.loaded_at = None, time.time()
            m = eng.model
            print(f"Loaded {model_id} in {time.time() - t:.1f}s on {m.device} ({str(m.dtype).replace('torch.', '')}), context {m.max_ctx}.", flush=True)
            return eng

    def _unload(self):
        if self.engine is None:
            return
        with self.engine.lock:  # wait for a running generation to finish
            name = self.model_id
            self.engine = self.fmt = None
            self.model_id = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        print(f"Unloaded {name}.", flush=True)

    def unload(self):
        with self.lock:
            self._unload()

    def status(self) -> dict:
        m = self.engine.model if self.engine else None
        return {"loaded": self.model_id, "loading": self.loading, "error": self.error, "ctx": self.ctx,
                "device": str(m.device) if m else None, "dtype": str(m.dtype).replace("torch.", "") if m else None,
                "note": getattr(m, "note", "") if m else ""}
