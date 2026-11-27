"""The Launch engine: runs Hugging Face transformer checkpoints directly from their safetensors files.

Supported architectures: Llama (1/2/3.x), Mistral, Qwen2/Qwen2.5 (incl. Coder), Qwen3.
Written from scratch on PyTorch tensors: RMSNorm, rotary embeddings (incl. Llama 3 scaling),
grouped-query attention with a preallocated KV cache, SwiGLU MLP, and sampling.
"""
from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import torch
import torch.nn.functional as F
from safetensors import safe_open
from tokenizers import Tokenizer

SUPPORTED = {"llama", "mistral", "qwen2", "qwen3"}


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

    @staticmethod
    def load(path: Path) -> "Config":
        c = json.loads((path / "config.json").read_text())
        arch = c.get("model_type", "")
        if arch not in SUPPORTED:
            raise ValueError(f"Launch can't run '{arch}' models yet. Supported: {', '.join(sorted(SUPPORTED))}.")
        if c.get("quantization_config"):
            raise ValueError("This checkpoint is pre-quantized (bitsandbytes/GPTQ/AWQ). Launch needs the regular "
                             "safetensors version, e.g. unsloth/Qwen2.5-Coder-7B-Instruct instead of a -bnb-4bit repo.")
        heads = c["num_attention_heads"]
        # Newer checkpoints keep rotary settings in "rope_parameters"; older ones use rope_theta + rope_scaling.
        rp = c.get("rope_parameters") or {}
        rope_theta = rp.get("rope_theta", c.get("rope_theta", 10000.0))
        rope_scaling = c.get("rope_scaling") or (rp if rp.get("rope_type", "default") != "default" else None)
        eos = c.get("eos_token_id")
        gen = path / "generation_config.json"
        if gen.exists():
            eos = json.loads(gen.read_text()).get("eos_token_id", eos)
        eos_ids = eos if isinstance(eos, list) else ([eos] if eos is not None else [])
        return Config(
            arch=arch,
            vocab_size=c["vocab_size"],
            hidden=c["hidden_size"],
            layers=c["num_hidden_layers"],
            heads=heads,
            kv_heads=c.get("num_key_value_heads") or heads,
            head_dim=c.get("head_dim") or c["hidden_size"] // heads,
            inter=c["intermediate_size"],
            eps=c.get("rms_norm_eps", 1e-6),
            rope_theta=rope_theta,
            rope_scaling=rope_scaling,
            max_pos=c.get("max_position_embeddings", 4096),
            tie_embeddings=bool(c.get("tie_word_embeddings", False)),
            eos_ids=[int(e) for e in eos_ids],
        )


def pick_device(want: str | None = None) -> tuple[torch.device, torch.dtype]:
    if want:
        dev = torch.device(want)
    elif torch.cuda.is_available():
        dev = torch.device("cuda")
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        dev = torch.device("mps")
    else:
        dev = torch.device("cpu")
    if dev.type == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    elif dev.type == "mps":
        dtype = torch.float16
    else:
        dtype = torch.float32
    return dev, dtype


def rms_norm(x: torch.Tensor, w: torch.Tensor, eps: float) -> torch.Tensor:
    xf = x.float()
    xf = xf * torch.rsqrt(xf.pow(2).mean(-1, keepdim=True) + eps)
    return (xf.to(x.dtype)) * w


def rope_inv_freq(cfg: Config) -> torch.Tensor:
    d = cfg.head_dim
    inv = 1.0 / (cfg.rope_theta ** (torch.arange(0, d, 2, dtype=torch.float64) / d))
    rs = cfg.rope_scaling or {}
    kind = rs.get("rope_type") or rs.get("type")
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
    return inv.float()


def apply_rope(x: torch.Tensor, cos: torch.Tensor, sin: torch.Tensor) -> torch.Tensor:
    # x: [b, h, t, d]; cos/sin: [t, d]
    half = x.shape[-1] // 2
    x1, x2 = x[..., :half], x[..., half:]
    rot = torch.cat((-x2, x1), dim=-1)
    return x * cos + rot * sin


class Model:
    """Weights + forward pass. One sequence at a time, with a KV cache."""

    def __init__(self, path: Path, device: str | None = None, max_ctx: int = 8192):
        self.path = Path(path)
        self.cfg = Config.load(self.path)
        self.device, self.dtype = pick_device(device)
        self.max_ctx = min(max_ctx, self.cfg.max_pos)
        self.w = self._load_weights()
        c = self.cfg
        self.has_qkv_bias = "model.layers.0.self_attn.q_proj.bias" in self.w
        self.has_qk_norm = "model.layers.0.self_attn.q_norm.weight" in self.w
        if "lm_head.weight" not in self.w:
            self.w["lm_head.weight"] = self.w["model.embed_tokens.weight"]
        inv = rope_inv_freq(c).to(self.device)
        t = torch.arange(self.max_ctx, device=self.device, dtype=torch.float32)
        freqs = torch.outer(t, inv)
        emb = torch.cat((freqs, freqs), dim=-1)
        self.cos = emb.cos().to(self.dtype)
        self.sin = emb.sin().to(self.dtype)
        shape = (c.layers, 1, c.kv_heads, self.max_ctx, c.head_dim)
        self.k_cache = torch.zeros(shape, dtype=self.dtype, device=self.device)
        self.v_cache = torch.zeros(shape, dtype=self.dtype, device=self.device)
        self.cached: list[int] = []  # token ids currently in the cache (prefix reuse)

    def _load_weights(self) -> dict[str, torch.Tensor]:
        files = sorted(self.path.glob("*.safetensors"))
        if not files:
            raise FileNotFoundError(f"No .safetensors files in {self.path}")
        w = {}
        for f in files:
            with safe_open(str(f), framework="pt", device="cpu") as sf:
                for k in sf.keys():
                    w[k] = sf.get_tensor(k).to(dtype=self.dtype).to(self.device)
        return w

    @torch.inference_mode()
    def forward(self, ids: list[int], start: int) -> torch.Tensor:
        """Run tokens `ids` at positions start..start+n-1, filling the cache. Returns logits of the last token."""
        c, w = self.cfg, self.w
        n = len(ids)
        if start + n > self.max_ctx:
            raise ValueError(f"Context is full ({self.max_ctx} tokens).")
        x = w["model.embed_tokens.weight"][torch.tensor(ids, device=self.device)].unsqueeze(0)  # [1, n, hidden]
        cos, sin = self.cos[start:start + n], self.sin[start:start + n]
        rep = c.heads // c.kv_heads
        for i in range(c.layers):
            p = f"model.layers.{i}."
            h = rms_norm(x, w[p + "input_layernorm.weight"], c.eps)
            q = F.linear(h, w[p + "self_attn.q_proj.weight"], w.get(p + "self_attn.q_proj.bias"))
            k = F.linear(h, w[p + "self_attn.k_proj.weight"], w.get(p + "self_attn.k_proj.bias"))
            v = F.linear(h, w[p + "self_attn.v_proj.weight"], w.get(p + "self_attn.v_proj.bias"))
            q = q.view(1, n, c.heads, c.head_dim).transpose(1, 2)
            k = k.view(1, n, c.kv_heads, c.head_dim).transpose(1, 2)
            v = v.view(1, n, c.kv_heads, c.head_dim).transpose(1, 2)
            if self.has_qk_norm:
                q = rms_norm(q, w[p + "self_attn.q_norm.weight"], c.eps)
                k = rms_norm(k, w[p + "self_attn.k_norm.weight"], c.eps)
            q, k = apply_rope(q, cos, sin), apply_rope(k, cos, sin)
            self.k_cache[i, :, :, start:start + n] = k
            self.v_cache[i, :, :, start:start + n] = v
            kk = self.k_cache[i, :, :, :start + n]
            vv = self.v_cache[i, :, :, :start + n]
            if rep > 1:
                kk = kk.repeat_interleave(rep, dim=1)
                vv = vv.repeat_interleave(rep, dim=1)
            if n == 1:
                attn = F.scaled_dot_product_attention(q, kk, vv)
            else:
                # causal mask that also sees the cached prefix
                mask = torch.ones(n, start + n, dtype=torch.bool, device=self.device).tril(diagonal=start)
                attn = F.scaled_dot_product_attention(q, kk, vv, attn_mask=mask)
            attn = attn.transpose(1, 2).reshape(1, n, c.heads * c.head_dim)
            x = x + F.linear(attn, w[p + "self_attn.o_proj.weight"])
            h = rms_norm(x, w[p + "post_attention_layernorm.weight"], c.eps)
            gate = F.linear(h, w[p + "mlp.gate_proj.weight"])
            up = F.linear(h, w[p + "mlp.up_proj.weight"])
            x = x + F.linear(F.silu(gate) * up, w[p + "mlp.down_proj.weight"])
        x = rms_norm(x[:, -1:], w["model.norm.weight"], c.eps)
        return F.linear(x, w["lm_head.weight"])[0, -1].float()

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
        self.model = Model(self.path, device, max_ctx)
        self.tokenizer = Tokenizer.from_file(str(self.path / "tokenizer.json"))
        self.lock = threading.Lock()
        tc = self.path / "tokenizer_config.json"
        self.tok_config = json.loads(tc.read_text()) if tc.exists() else {}
        self.stop_ids = set(self.model.cfg.eos_ids)
        for t in ("<|im_end|>", "<|eot_id|>", "<|end_of_text|>", "</s>", "<|endoftext|>"):
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
