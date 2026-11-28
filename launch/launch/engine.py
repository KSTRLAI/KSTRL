"""The Launch engine: runs Hugging Face transformer checkpoints directly from their weight files.

Written from scratch on PyTorch tensors — no transformers, no llama.cpp. One config-driven decoder covers:
  Llama 1/2/3.x (and Llama-architecture models: SmolLM, DeepSeek-R1-Distill-Llama, TinyLlama, Arcee…),
  Mistral, Qwen2/2.5 (incl. Coder, DeepSeek-R1-Distill-Qwen), Qwen3, Gemma 1/2/3 (text), Phi-3/3.5/4-mini,
  IBM Granite, OLMo 2/3, StarCoder2, SmolLM3, Seed-OSS, and mixture-of-experts Mixtral / Qwen2-MoE / Qwen3-MoE.
Pieces: RMSNorm / Gemma norm / LayerNorm, rotary embeddings (default, Llama 3, linear, YaRN, LongRoPE, partial),
grouped-query attention with a KV cache and sliding windows, gated and plain MLPs, top-k expert routing, sampling.
Weights load from .safetensors or PyTorch .bin files.
"""
from __future__ import annotations

import json
import math
import os
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import torch
import torch.nn.functional as F
from tokenizers import Tokenizer

LLAMA_LIKE = {"llama", "mistral", "qwen2", "qwen3", "granite", "smollm3", "seed_oss", "arcee", "ernie4_5"}
GEMMA = {"gemma", "gemma2", "gemma3_text"}
OLMO = {"olmo2", "olmo3"}
MOE = {"mixtral", "qwen2_moe", "qwen3_moe"}
SUPPORTED = LLAMA_LIKE | GEMMA | OLMO | MOE | {"phi3", "starcoder2"}
NAMES = ("Llama, Mistral, Qwen2/2.5/3, Qwen MoE, Mixtral, Gemma 1/2/3, Phi-3/3.5/4-mini, Granite, OLMo 2/3, "
         "StarCoder2, SmolLM3, Seed-OSS, DeepSeek-R1-Distill")


def say(msg: str):
    print(msg, file=sys.stderr, flush=True)


@dataclass
class Config:
    arch: str
    vocab_size: int
    hidden: int
    layers: int
    heads: int
    kv_heads: int
    head_dim: int
    inter: int
    eps: float
    rope_theta: float
    rope_scaling: dict | None
    max_pos: int
    tie_embeddings: bool
    eos_ids: list[int] = field(default_factory=list)
    rot_dim: int = 0                      # rotary dims per head (partial rotary < head_dim)
    orig_max_pos: int | None = None       # LongRoPE / YaRN original context
    norm_kind: str = "rms"                # rms | gemma | layer
    norm_style: str = "pre"               # pre | sandwich (Gemma 2/3) | post (OLMo 2)
    qk_norm: str | None = None            # head (Qwen3, Gemma 3) | full (OLMo 2)
    act: str = "silu"                     # silu | gelu_tanh | gelu | relu2
    gated: bool = True                    # SwiGLU/GeGLU vs plain MLP
    query_scale: float | None = None      # attention scale (default 1/sqrt(head_dim))
    attn_softcap: float | None = None
    final_softcap: float | None = None
    sliding_window: int | None = None
    sliding: list[bool] = field(default_factory=list)  # per layer: local (sliding-window) attention
    no_rope: list[bool] = field(default_factory=list)  # per layer: skip rotary (SmolLM3)
    local_rope_theta: float | None = None
    embed_scale: float = 1.0
    residual_scale: float = 1.0
    logits_div: float = 1.0
    # mixture of experts
    experts: int = 0
    top_k: int = 0
    norm_topk: bool = True
    moe_layers: list[bool] = field(default_factory=list)
    moe_inter: int = 0
    shared_expert: bool = False

    @staticmethod
    def load(path: Path) -> "Config":
        c = json.loads((path / "config.json").read_text())
        arch = c.get("model_type", "")
        if isinstance(c.get("text_config"), dict) and arch not in SUPPORTED:
            raise ValueError(f"This is a multimodal ({arch}) checkpoint. Launch runs text-only models — e.g. google/gemma-3-1b-it, "
                             "or the text version of this model if there is one.")
        if arch not in SUPPORTED:
            raise ValueError(f"Launch can't run '{arch}' models yet. Supported: {NAMES}.")
        if c.get("quantization_config"):
            raise ValueError("This checkpoint is pre-quantized (bitsandbytes/GPTQ/AWQ/FP8). Launch needs the regular full-precision "
                             "version, e.g. Qwen/Qwen2.5-Coder-7B-Instruct instead of a -bnb-4bit / -AWQ / -GPTQ repo.")
        heads = c["num_attention_heads"]
        head_dim = c.get("head_dim") or c["hidden_size"] // heads
        # Newer checkpoints keep rotary settings in "rope_parameters"; older ones use rope_theta + rope_scaling.
        rp = c.get("rope_parameters") or {}
        local_theta = None
        if "full_attention" in rp or "sliding_attention" in rp:  # per layer type (Gemma 3, OLMo 3)
            local_theta = (rp.get("sliding_attention") or {}).get("rope_theta")
            rp = rp.get("full_attention") or {}
        rs = c.get("rope_scaling")
        if isinstance(rs, dict) and ("full_attention" in rs or "sliding_attention" in rs):
            rs = rs.get("full_attention")
        kind = lambda d: (d or {}).get("rope_type") or (d or {}).get("type") or "default"  # noqa: E731
        rope_scaling = rs if kind(rs) not in ("default", None) else (rp if kind(rp) != "default" else None)
        if rope_scaling and kind(rope_scaling) in ("dynamic",):
            rope_scaling = None  # dynamic NTK only kicks in past the trained length; treat as default
        rope_theta = rp.get("rope_theta", c.get("rope_theta", 10000.0))
        prf = rp.get("partial_rotary_factor", c.get("partial_rotary_factor", 1.0))
        eos = c.get("eos_token_id")
        gen = path / "generation_config.json"
        if gen.exists():
            eos = json.loads(gen.read_text()).get("eos_token_id", eos)
        eos_ids = eos if isinstance(eos, list) else ([eos] if eos is not None else [])
        layers = c["num_hidden_layers"]
        cfg = Config(
            arch=arch,
            vocab_size=c["vocab_size"],
            hidden=c["hidden_size"],
            layers=layers,
            heads=heads,
            kv_heads=c.get("num_key_value_heads") or heads,
            head_dim=head_dim,
            inter=c.get("intermediate_size") or 4 * c["hidden_size"],
            eps=c.get("rms_norm_eps", c.get("norm_epsilon", c.get("layer_norm_eps", 1e-6))),
            rope_theta=rope_theta,
            rope_scaling=rope_scaling,
            max_pos=c.get("max_position_embeddings", 4096),
            tie_embeddings=bool(c.get("tie_word_embeddings", False)),
            eos_ids=[int(e) for e in eos_ids if e is not None],
            rot_dim=int(head_dim * prf) // 2 * 2,
            orig_max_pos=(rope_scaling or {}).get("original_max_position_embeddings") or c.get("original_max_position_embeddings"),
        )
        if c.get("layer_types"):
            cfg.sliding = [t == "sliding_attention" for t in c["layer_types"]]
        if c.get("sliding_window") and c.get("use_sliding_window", True) is not False and not cfg.sliding and arch in ("mistral", "starcoder2", "mixtral", "phi3"):
            cfg.sliding = [True] * layers
        if arch in GEMMA:
            Config._gemma(cfg, c, arch, local_theta)
        if arch in OLMO:
            cfg.norm_style, cfg.qk_norm = "post", "full"
            if arch == "olmo3" and local_theta:
                cfg.local_rope_theta = None  # OLMo 3 uses one rotary base for both layer types
        if arch == "qwen3" or arch == "qwen3_moe":
            cfg.qk_norm = "head"
        if arch == "granite":
            cfg.embed_scale = c.get("embedding_multiplier", 1.0)
            cfg.residual_scale = c.get("residual_multiplier", 1.0)
            cfg.query_scale = c.get("attention_multiplier")
            cfg.logits_div = c.get("logits_scaling", 1.0)
        if arch == "starcoder2":
            cfg.norm_kind, cfg.gated, cfg.act = "layer", False, "gelu_tanh"
        if arch == "arcee":
            cfg.gated, cfg.act = False, "relu2"
        if arch == "smollm3" and c.get("no_rope_layers"):
            cfg.no_rope = [not bool(x) for x in c["no_rope_layers"]]
        if arch in MOE:
            cfg.experts = c.get("num_local_experts") or c.get("num_experts") or 0
            cfg.top_k = c.get("num_experts_per_tok", 2)
            cfg.norm_topk = True if arch == "mixtral" else bool(c.get("norm_topk_prob", arch == "qwen3_moe"))
            cfg.moe_inter = c.get("moe_intermediate_size") or cfg.inter
            only = set(c.get("mlp_only_layers") or [])
            step = c.get("decoder_sparse_step", 1) or 1
            cfg.moe_layers = [i not in only and (i + 1) % step == 0 for i in range(layers)]
            cfg.shared_expert = arch == "qwen2_moe" and bool(c.get("shared_expert_intermediate_size"))
        if cfg.sliding and any(cfg.sliding):
            cfg.sliding_window = c.get("sliding_window")
        if not cfg.sliding_window:
            cfg.sliding = []
        return cfg

    @staticmethod
    def _gemma(cfg: "Config", c: dict, arch: str, local_theta):
        layers = cfg.layers
        if not cfg.sliding:
            if arch == "gemma2":
                cfg.sliding = [i % 2 == 0 for i in range(layers)]
            elif arch == "gemma3_text":
                pat = c.get("sliding_window_pattern", 6)
                cfg.sliding = [(i + 1) % pat != 0 for i in range(layers)]
        q = c.get("query_pre_attn_scalar")
        cfg.norm_kind = "gemma"
        cfg.act = "gelu_tanh"
        cfg.query_scale = q ** -0.5 if q else None
        cfg.attn_softcap = c.get("attn_logit_softcapping") if arch == "gemma2" else None
        cfg.final_softcap = c.get("final_logit_softcapping")
        cfg.local_rope_theta = (local_theta or c.get("rope_local_base_freq")) if arch == "gemma3_text" else None
        cfg.norm_style = "pre" if arch == "gemma" else "sandwich"
        cfg.qk_norm = "head" if arch == "gemma3_text" else None
        cfg.embed_scale = cfg.hidden ** 0.5
        cfg.tie_embeddings = True


# ---------------- device ----------------
def total_ram() -> int:
    try:
        if os.name == "nt":
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("x", ctypes.c_ulonglong)]
            m = MS()
            m.len = ctypes.sizeof(MS)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return int(m.avail)
        return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except Exception:  # noqa: BLE001
        return 0


def weight_numel(path: Path) -> int:
    n = 0
    for f in sorted(path.glob("*.safetensors")):
        with open(f, "rb") as fh:
            hlen = int.from_bytes(fh.read(8), "little")
            meta = json.loads(fh.read(hlen))
        for k, v in meta.items():
            if k != "__metadata__":
                n += math.prod(v["shape"])
    if not n:
        n = sum(f.stat().st_size for f in path.glob("pytorch_model*.bin")) // 2
    return n


def pick_device(want: str | None, cfg: Config, path: Path, max_ctx: int) -> tuple[torch.device, torch.dtype, str]:
    """Best device that can actually hold and run this model. Returns (device, dtype, note)."""
    numel = weight_numel(path)
    kv = 2 * cfg.layers * cfg.kv_heads * max_ctx * cfg.head_dim
    if want and want != "auto":
        dev = torch.device(want)
        if dev.type == "cpu":
            return dev, torch.float32 if numel * 4 < total_ram() * 0.8 or not total_ram() else torch.bfloat16, ""
        return dev, torch.float16 if dev.type == "mps" else (torch.bfloat16 if torch.cuda.get_device_capability(dev)[0] >= 8 else torch.float16), ""
    note = ""
    if torch.cuda.is_available():
        try:
            name = torch.cuda.get_device_name(0)
            cap = torch.cuda.get_device_capability(0)
            torch.ones(4, device="cuda").mul_(2).sum().item()  # fails if this PyTorch build lacks kernels for the card
            bf16 = cap[0] >= 8  # bf16 is native from RTX 30xx / A100 on; older cards use fp16
            dtype = torch.bfloat16 if bf16 else torch.float16
            if cfg.norm_kind == "gemma" and not bf16:
                dtype = torch.float32  # Gemma overflows in fp16
            size = (numel + kv) * (4 if dtype == torch.float32 else 2) + 400 * 2**20
            free, _ = torch.cuda.mem_get_info()
            if size <= free * 0.95:
                return torch.device("cuda"), dtype, f"GPU {name}"
            note = (f"{name} has {free / 2**30:.1f} GB free but this model needs about {size / 2**30:.1f} GB"
                    + (" (Gemma needs full precision on this card)" if dtype == torch.float32 else "") + " — running on the CPU instead. "
                    "Pick a smaller model or a smaller context to use the GPU.")
        except Exception as e:  # noqa: BLE001
            note = f"The GPU can't run this PyTorch build ({str(e).splitlines()[0][:120]}) — running on the CPU. Settings → Reinstall runtime may fix it."
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps"), torch.float16 if cfg.norm_kind != "gemma" else torch.float32, "Apple GPU"
    ram = total_ram()
    dtype = torch.float32 if not ram or numel * 4 < ram * 0.8 else torch.bfloat16  # halve memory when RAM is tight
    return torch.device("cpu"), dtype, note


# ---------------- math ----------------
def rms_norm(x: torch.Tensor, w: torch.Tensor, b, eps: float) -> torch.Tensor:
    xf = x.float()
    xf = xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps)
    return (xf.to(x.dtype)) * w


def gemma_norm(x: torch.Tensor, w: torch.Tensor, b, eps: float) -> torch.Tensor:
    xf = x.float()
    xf = xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps)
    return (xf * (1.0 + w.float())).to(x.dtype)


def layer_norm(x: torch.Tensor, w: torch.Tensor, b, eps: float) -> torch.Tensor:
    return F.layer_norm(x.float(), (x.shape[-1],), w.float(), None if b is None else b.float(), eps).to(x.dtype)


NORMS = {"rms": rms_norm, "gemma": gemma_norm, "layer": layer_norm}
ACTS = {"silu": F.silu, "gelu_tanh": lambda t: F.gelu(t, approximate="tanh"), "gelu": F.gelu, "relu2": lambda t: torch.relu(t).square()}


def rope_inv_freq(cfg: Config, theta: float | None = None, scaling: bool = True, long: bool = False) -> tuple[torch.Tensor, float]:
    """Inverse frequencies for the rotary dims, and the attention scaling factor applied to cos/sin."""
    d = cfg.rot_dim or cfg.head_dim
    base = theta or cfg.rope_theta
    inv = 1.0 / (base ** (torch.arange(0, d, 2, dtype=torch.float64) / d))
    rs = (cfg.rope_scaling or {}) if scaling else {}
    kind = rs.get("rope_type") or rs.get("type")
    mscale = 1.0
    if kind == "llama3":
        factor = rs["factor"]
        low, high = rs.get("low_freq_factor", 1.0), rs.get("high_freq_factor", 4.0)
        old = rs.get("original_max_position_embeddings", 8192)
        low_wl, high_wl = old / low, old / high
        wl = 2 * math.pi / inv
        scaled = torch.where(wl > low_wl, inv / factor, inv)
        smooth = (old / wl - low) / (high - low)
        mid = (1 - smooth) * scaled / factor + smooth * scaled
        is_mid = (wl <= low_wl) & (wl >= high_wl)
        inv = torch.where(is_mid, mid, scaled)
    elif kind == "linear":
        inv = inv / rs["factor"]
    elif kind == "yarn":
        factor = rs["factor"]
        orig = rs.get("original_max_position_embeddings") or cfg.orig_max_pos or cfg.max_pos
        mscale = rs.get("attention_factor") or (0.1 * math.log(factor) + 1.0 if factor > 1 else 1.0)
        bf, bs = rs.get("beta_fast", 32), rs.get("beta_slow", 1)

        def corr(n):
            return (d * math.log(orig / (n * 2 * math.pi))) / (2 * math.log(base))
        lo, hi = corr(bf), corr(bs)
        if rs.get("truncate", True):
            lo, hi = math.floor(lo), math.ceil(hi)
        lo, hi = max(lo, 0), min(hi, d - 1)
        if lo == hi:
            hi += 0.001
        ramp = ((torch.arange(d // 2, dtype=torch.float64) - lo) / (hi - lo)).clamp(0, 1)
        extra = 1 - ramp
        inv = (inv / factor) * (1 - extra) + inv * extra
    elif kind in ("longrope", "su"):
        orig = rs.get("original_max_position_embeddings") or cfg.orig_max_pos or cfg.max_pos
        ext = torch.tensor(rs["long_factor"] if long else rs["short_factor"], dtype=torch.float64)
        inv = inv / ext
        factor = rs.get("factor") or cfg.max_pos / orig
        mscale = rs.get("attention_factor") or (math.sqrt(1 + math.log(factor) / math.log(orig)) if factor > 1 else 1.0)
    return inv.float(), mscale


def apply_rope(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    # x: [b, h, t, d]; cos/sin: [t, r] with r <= d (partial rotary rotates the first r dims)
    r = cos.shape[-1]
    if r < x.shape[-1]:
        return torch.cat((apply_rope(x[..., :r], cos, sin), x[..., r:]), dim=-1)
    half = r // 2
    x1, x2 = x[..., :half], x[..., half:]
    rot = torch.cat((-x2, x1), dim=-1)
    return x * cos + rot * sin


class Model:
    """Weights + forward pass. One sequence at a time, with a KV cache."""

    def __init__(self, path: Path, device: str | None = None, max_ctx: int = 8192):
        self.path = Path(path)
        self.cfg = c = Config.load(self.path)
        self.max_ctx = min(max_ctx, c.max_pos)
        self.device, self.dtype, self.note = pick_device(device, c, self.path, self.max_ctx)
        if self.note:
            say(self.note)
        self.w = self._load_weights()
        self._normalise_names()
        if "lm_head.weight" not in self.w:
            self.w["lm_head.weight"] = self.w["model.embed_tokens.weight"]
        t = torch.arange(self.max_ctx, device=self.device, dtype=torch.float32)

        def table(args):
            inv, mscale = args
            freqs = torch.outer(t, inv.to(self.device))
            emb = torch.cat((freqs, freqs), dim=-1)
            return (emb.cos() * mscale).to(self.dtype), (emb.sin() * mscale).to(self.dtype)
        self.cos, self.sin = table(rope_inv_freq(c))
        kind = (c.rope_scaling or {}).get("rope_type") or (c.rope_scaling or {}).get("type")
        self.longrope = kind in ("longrope", "su")
        if self.longrope:  # Phi-3: short factors up to the original length, long factors past it
            self.cos_long, self.sin_long = table(rope_inv_freq(c, long=True))
            self.long_from = (c.rope_scaling or {}).get("original_max_position_embeddings") or c.orig_max_pos or c.max_pos
        # Gemma 3 sliding-window layers use their own rotary base, without scaling.
        self.cos_l, self.sin_l = table(rope_inv_freq(c, c.local_rope_theta, scaling=False)) if c.local_rope_theta else (self.cos, self.sin)
        self.norm = NORMS[c.norm_kind]
        self.act = ACTS[c.act]
        shape = (c.layers, 1, c.kv_heads, self.max_ctx, c.head_dim)
        self.k_cache = torch.zeros(shape, dtype=self.dtype, device=self.device)
        self.v_cache = torch.zeros(shape, dtype=self.dtype, device=self.device)
        self.cached: list[int] = []  # token ids currently in the cache (prefix reuse)

    def _load_weights(self) -> dict[str, torch.Tensor]:
        files = sorted(self.path.glob("*.safetensors"))
        w = {}
        if files:
            from safetensors import safe_open
            for f in files:
                with safe_open(str(f), framework="pt", device="cpu") as sf:
                    for k in sf.keys():
                        w[k] = sf.get_tensor(k).to(dtype=self.dtype).to(self.device)
            return w
        bins = sorted(self.path.glob("pytorch_model*.bin"))
        if not bins:
            raise FileNotFoundError(f"No .safetensors or pytorch_model.bin weights in {self.path}")
        for f in bins:
            for k, v in torch.load(str(f), map_location="cpu", weights_only=True).items():
                w[k] = v.to(dtype=self.dtype).to(self.device)
        return w

    def _normalise_names(self):
        """Map every supported layout onto one naming scheme (Llama's), splitting fused tensors."""
        c, w = self.cfg, self.w
        for k in list(w):  # some checkpoints prefix with "transformer." or "model.language_model."
            for pre in ("model.language_model.", "language_model.model."):
                if k.startswith(pre):
                    w["model." + k[len(pre):]] = w.pop(k)
        for i in range(c.layers):
            p = f"model.layers.{i}."
            qkv = w.pop(p + "self_attn.qkv_proj.weight", None)  # Phi-3
            if qkv is not None:
                q, kv = c.heads * c.head_dim, c.kv_heads * c.head_dim
                w[p + "self_attn.q_proj.weight"], w[p + "self_attn.k_proj.weight"], w[p + "self_attn.v_proj.weight"] = qkv.split([q, kv, kv])
            gu = w.pop(p + "mlp.gate_up_proj.weight", None)  # Phi-3
            if gu is not None:
                w[p + "mlp.gate_proj.weight"], w[p + "mlp.up_proj.weight"] = gu.chunk(2, dim=0)
            for a, b in (("mlp.c_fc.", "mlp.up_proj."), ("mlp.c_proj.", "mlp.down_proj.")):  # StarCoder2
                for s in ("weight", "bias"):
                    if p + a + s in w:
                        w[p + b + s] = w.pop(p + a + s)
            # Mixtral: block_sparse_moe.{gate, experts.N.w1/w2/w3}
            if p + "block_sparse_moe.gate.weight" in w:
                w[p + "mlp.gate.weight"] = w.pop(p + "block_sparse_moe.gate.weight")
                for e in range(c.experts):
                    for a, b in (("w1", "gate_proj"), ("w3", "up_proj"), ("w2", "down_proj")):
                        w[f"{p}mlp.experts.{e}.{b}.weight"] = w.pop(f"{p}block_sparse_moe.experts.{e}.{a}.weight")
            # experts stored fused as 3-D tensors (newer saves): split per expert
            fused = w.pop(p + "mlp.experts.gate_up_proj", None)
            if fused is not None:
                down = w.pop(p + "mlp.experts.down_proj")
                for e in range(fused.shape[0]):
                    g, u = fused[e].chunk(2, dim=-1 if fused.shape[-1] == 2 * c.moe_inter else 0)
                    t = fused.shape[-1] == 2 * c.moe_inter  # [hidden, 2*inter] → transpose
                    w[f"{p}mlp.experts.{e}.gate_proj.weight"] = g.T.contiguous() if t else g
                    w[f"{p}mlp.experts.{e}.up_proj.weight"] = u.T.contiguous() if t else u
                    d = down[e]
                    w[f"{p}mlp.experts.{e}.down_proj.weight"] = d.T.contiguous() if d.shape[0] == c.moe_inter else d

    def _mlp(self, h, p):
        w = self.w
        up = F.linear(h, w[p + "up_proj.weight"], w.get(p + "up_proj.bias"))
        mid = self.act(F.linear(h, w[p + "gate_proj.weight"])) * up if self.cfg.gated else self.act(up)
        return F.linear(mid, w[p + "down_proj.weight"], w.get(p + "down_proj.bias"))

    def _moe(self, h, p):
        c, w = self.cfg, self.w
        flat = h.reshape(-1, h.shape[-1])
        probs = torch.softmax(F.linear(flat, w[p + "gate.weight"]).float(), dim=-1)
        topw, topi = probs.topk(c.top_k, dim=-1)
        if c.norm_topk:
            topw = topw / topw.sum(-1, keepdim=True)
        out = torch.zeros_like(flat)
        for e in topi.unique().tolist():
            rows, slot = (topi == e).nonzero(as_tuple=True)
            y = self._mlp(flat[rows], f"{p}experts.{e}.")
            out.index_add_(0, rows, (y * topw[rows, slot, None].to(y.dtype)))
        if c.shared_expert:
            s = self._mlp(flat, p + "shared_expert.")
            out = out + torch.sigmoid(F.linear(flat, w[p + "shared_expert_gate.weight"])) * s
        return out.view_as(h)

    @torch.inference_mode()
    def forward(self, ids: list[int], start: int) -> torch.Tensor:
        """Run tokens `ids` at positions start..start+n-1, filling the cache. Returns logits of the last token."""
        c, w = self.cfg, self.w
        n = len(ids)
        if start + n > self.max_ctx:
            raise ValueError(f"Context is full ({self.max_ctx} tokens).")
        x = w["model.embed_tokens.weight"][torch.tensor(ids, device=self.device)].unsqueeze(0)  # [1, n, hidden]
        if c.embed_scale != 1.0:
            x = x * torch.tensor(c.embed_scale, dtype=x.dtype)
        norm, eps = self.norm, c.eps
        rep = c.heads // c.kv_heads
        scale = c.query_scale or c.head_dim ** -0.5
        qi = torch.arange(start, start + n, device=self.device).unsqueeze(1)
        kj = torch.arange(start + n, device=self.device).unsqueeze(0)
        causal = kj <= qi
        local_mask = (causal & (qi - kj < c.sliding_window)) if c.sliding_window else causal
        use_long = self.longrope and start + n > self.long_from
        for i in range(c.layers):
            p = f"model.layers.{i}."
            local = bool(c.sliding and c.sliding[i])
            cos, sin = (self.cos_l, self.sin_l) if local else ((self.cos_long, self.sin_long) if use_long else (self.cos, self.sin))
            cos, sin = cos[start:start + n], sin[start:start + n]
            h = x if c.norm_style == "post" else norm(x, w[p + "input_layernorm.weight"], w.get(p + "input_layernorm.bias"), eps)
            q = F.linear(h, w[p + "self_attn.q_proj.weight"], w.get(p + "self_attn.q_proj.bias"))
            k = F.linear(h, w[p + "self_attn.k_proj.weight"], w.get(p + "self_attn.k_proj.bias"))
            v = F.linear(h, w[p + "self_attn.v_proj.weight"], w.get(p + "self_attn.v_proj.bias"))
            if c.qk_norm == "full":
                q = norm(q, w[p + "self_attn.q_norm.weight"], None, eps)
                k = norm(k, w[p + "self_attn.k_norm.weight"], None, eps)
            q = q.view(1, n, c.heads, c.head_dim).transpose(1, 2)
            k = k.view(1, n, c.kv_heads, c.head_dim).transpose(1, 2)
            v = v.view(1, n, c.kv_heads, c.head_dim).transpose(1, 2)
            if c.qk_norm == "head":
                q = norm(q, w[p + "self_attn.q_norm.weight"], None, eps)
                k = norm(k, w[p + "self_attn.k_norm.weight"], None, eps)
            if not (c.no_rope and c.no_rope[i]):
                rd = c.rot_dim or c.head_dim
                q, k = apply_rope(q, cos[:, :rd], sin[:, :rd]), apply_rope(k, cos[:, :rd], sin[:, :rd])
            self.k_cache[i, :, :, start:start + n] = k
            self.v_cache[i, :, :, start:start + n] = v
            kk = self.k_cache[i, :, :, :start + n]
            vv = self.v_cache[i, :, :, :start + n]
            if rep > 1:
                kk = kk.repeat_interleave(rep, dim=1)
                vv = vv.repeat_interleave(rep, dim=1)
            mask = local_mask if local else causal
            if c.attn_softcap:
                scores = torch.matmul(q.float(), kk.float().transpose(-1, -2)) * scale
                scores = torch.tanh(scores / c.attn_softcap) * c.attn_softcap
                attn = torch.matmul(torch.softmax(scores.masked_fill(~mask, float("-inf")), dim=-1), vv.float()).to(self.dtype)
            else:
                attn = F.scaled_dot_product_attention(q, kk, vv, attn_mask=mask, scale=scale)
            attn = attn.transpose(1, 2).reshape(1, n, c.heads * c.head_dim)
            o = F.linear(attn, w[p + "self_attn.o_proj.weight"], w.get(p + "self_attn.o_proj.bias"))
            if c.norm_style == "sandwich" or c.norm_style == "post":
                o = norm(o, w[p + "post_attention_layernorm.weight"], None, eps)
            x = x + o * c.residual_scale if c.residual_scale != 1.0 else x + o
            if c.norm_style == "sandwich":
                h = norm(x, w[p + "pre_feedforward_layernorm.weight"], None, eps)
            elif c.norm_style == "post":
                h = x
            else:
                h = norm(x, w[p + "post_attention_layernorm.weight"], w.get(p + "post_attention_layernorm.bias"), eps)
            m = self._moe(h, p + "mlp.") if c.moe_layers and c.moe_layers[i] else self._mlp(h, p + "mlp.")
            if c.norm_style in ("sandwich", "post"):
                m = norm(m, w[p + "post_feedforward_layernorm.weight"], None, eps)
            x = x + m * c.residual_scale if c.residual_scale != 1.0 else x + m
        x = norm(x[:, -1:], w["model.norm.weight"], w.get("model.norm.bias"), eps)
        logits = F.linear(x, w["lm_head.weight"], w.get("lm_head.bias"))[0, -1].float()
        if c.logits_div != 1.0:
            logits = logits / c.logits_div
        if c.final_softcap:
            logits = torch.tanh(logits / c.final_softcap) * c.final_softcap
        return logits

    @torch.inference_mode()
    def full_logits(self, ids: list[int]) -> torch.Tensor:
        """Logits for every position (used by tests to compare against a reference)."""
        out = []
        self.cached = []
        for pos in range(len(ids)):
            out.append(self.forward([ids[pos]], pos))
        return torch.stack(out)


@dataclass
class SampleParams:
    max_tokens: int = 1024
    temperature: float = 0.7
    top_p: float = 0.95
    top_k: int = 50
    stop: list[str] = field(default_factory=list)


def sample(logits: torch.Tensor, p: SampleParams, gen: torch.Generator | None = None) -> int:
    if p.temperature <= 0:
        return int(logits.argmax())
    logits = logits / p.temperature
    if p.top_k and p.top_k > 0:
        kth = torch.topk(logits, min(p.top_k, logits.shape[-1])).values[-1]
        logits = logits.masked_fill(logits < kth, float("-inf"))
    probs = torch.softmax(logits, dim=-1)
    if p.top_p < 1.0:
        sp, si = torch.sort(probs, descending=True)
        cum = sp.cumsum(-1)
        sp[(cum - sp) > p.top_p] = 0
        probs = torch.zeros_like(probs).scatter(0, si, sp)
        probs = probs / probs.sum()
    return int(torch.multinomial(probs, 1, generator=gen))


class Engine:
    """Model + tokenizer + a generation loop that streams text. One request at a time."""

    def __init__(self, path: str | Path, device: str | None = None, max_ctx: int = 8192, name: str | None = None):
        self.path = Path(path)
        self.name = name or self.path.name
        if not (self.path / "tokenizer.json").exists():
            raise FileNotFoundError("This model has no tokenizer.json (only an older tokenizer format). Try a newer upload of it — "
                                    "most models on Hugging Face include tokenizer.json.")
        self.model = Model(self.path, device, max_ctx)
        self.tokenizer = Tokenizer.from_file(str(self.path / "tokenizer.json"))
        self.lock = threading.Lock()
        tc = self.path / "tokenizer_config.json"
        self.tok_config = json.loads(tc.read_text()) if tc.exists() else {}
        self.stop_ids = set(self.model.cfg.eos_ids)
        for t in ("<|im_end|>", "<|eot_id|>", "<|end_of_text|>", "</s>", "<|endoftext|>", "<end_of_turn>", "<|end|>", "<|eom_id|>"):
            i = self.tokenizer.token_to_id(t)
            if i is not None:
                self.stop_ids.add(i)

    def encode(self, text: str) -> list[int]:
        return self.tokenizer.encode(text, add_special_tokens=False).ids

    def generate(self, prompt_ids: list[int], params: SampleParams, cancel: threading.Event | None = None) -> Iterator[dict]:
        """Yields {"text": delta} while generating, then {"done": True, "finish": "stop"|"length", "prompt_tokens", "completion_tokens"}."""
        with self.lock:
            m = self.model
            if len(prompt_ids) >= m.max_ctx:
                raise ValueError(f"The prompt is {len(prompt_ids)} tokens; this model is loaded with a {m.max_ctx}-token context.")
            # Reuse the cached prefix shared with the previous request (chat turns grow at the end).
            common = 0
            for a, b in zip(m.cached, prompt_ids):
                if a != b:
                    break
                common += 1
            common = min(common, len(prompt_ids) - 1)
            logits = None
            chunk = 512
            pos = common
            while pos < len(prompt_ids):
                part = prompt_ids[pos:pos + chunk]
                logits = m.forward(part, pos)
                pos += len(part)
            m.cached = list(prompt_ids)
            out: list[int] = []
            emitted = ""
            finish = "length"
            budget = min(params.max_tokens, m.max_ctx - len(prompt_ids))
            for _ in range(max(0, budget)):
                if cancel is not None and cancel.is_set():
                    finish = "stop"
                    break
                tok = sample(logits, params)
                if tok in self.stop_ids:
                    finish = "stop"
                    break
                out.append(tok)
                text = self.tokenizer.decode(out, skip_special_tokens=False)
                if text.endswith("�"):  # incomplete multi-byte character: wait for the next token
                    logits = m.forward([tok], len(m.cached))
                    m.cached.append(tok)
                    continue
                delta = text[len(emitted):]
                hit = next((s for s in params.stop if s and s in text), None)
                if hit:
                    cut = text.index(hit)
                    if cut > len(emitted):
                        yield {"text": text[len(emitted):cut]}
                    finish = "stop"
                    break
                if delta:
                    yield {"text": delta}
                    emitted = text
                logits = m.forward([tok], len(m.cached))
                m.cached.append(tok)
            yield {"done": True, "finish": finish, "prompt_tokens": len(prompt_ids), "completion_tokens": len(out)}
