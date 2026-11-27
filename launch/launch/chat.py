"""Chat templates (from the model's tokenizer_config.json) and tool-call parsing."""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime

from jinja2.sandbox import ImmutableSandboxedEnvironment

FALLBACK_TEMPLATE = (
    "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}"
    "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}"
)


def _token_str(v):
    if isinstance(v, dict):
        return v.get("content", "")
    return v or ""


class ChatFormat:
    def __init__(self, tok_config: dict):
        tpl = tok_config.get("chat_template") or FALLBACK_TEMPLATE
        if isinstance(tpl, list):  # [{name, template}, ...]
            named = {t.get("name"): t.get("template") for t in tpl}
            self.tool_template = named.get("tool_use")
            tpl = named.get("default") or next(iter(named.values()))
        else:
            self.tool_template = None
        env = ImmutableSandboxedEnvironment(trim_blocks=True, lstrip_blocks=True, extensions=["jinja2.ext.loopcontrols"])

        def raise_exception(msg):
            raise ValueError(msg)

        env.filters["tojson"] = lambda x, indent=None, ensure_ascii=False, separators=None, sort_keys=False: json.dumps(
            x, indent=indent, ensure_ascii=ensure_ascii, separators=separators, sort_keys=sort_keys)
        env.globals["raise_exception"] = raise_exception
        env.globals["strftime_now"] = lambda fmt: datetime.now().strftime(fmt)
        self.env = env
        self.template = env.from_string(tpl)
        self.tool_tpl = env.from_string(self.tool_template) if self.tool_template else None
        self.bos = _token_str(tok_config.get("bos_token"))
        self.eos = _token_str(tok_config.get("eos_token"))

    def render(self, messages: list[dict], tools: list[dict] | None = None) -> str:
        msgs = [normalize_message(m) for m in messages]
        tpl = self.tool_tpl if (tools and self.tool_tpl) else self.template
        return tpl.render(messages=msgs, tools=tools or None, add_generation_prompt=True,
                          bos_token=self.bos, eos_token=self.eos)


def normalize_message(m: dict) -> dict:
    """OpenAI message → what HF chat templates expect (text content, tool-call arguments as objects)."""
    out = {"role": m.get("role", "user")}
    content = m.get("content")
    if isinstance(content, list):  # [{type:'text'}, {type:'image_url'}] — images aren't supported yet
        texts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
        if any(isinstance(p, dict) and p.get("type") in ("image_url", "image") for p in content):
            texts.append("[An image was attached, but this model can't see images.]")
        content = "\n".join(texts)
    out["content"] = content or ""
    if m.get("tool_calls"):
        calls = []
        for c in m["tool_calls"]:
            fn = dict(c.get("function", {}))
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    fn["arguments"] = json.loads(args) if args.strip() else {}
                except json.JSONDecodeError:
                    fn["arguments"] = {}
            calls.append({"id": c.get("id"), "type": "function", "function": fn})
        out["tool_calls"] = calls
    if m.get("tool_call_id"):
        out["tool_call_id"] = m["tool_call_id"]
    if m.get("name"):
        out["name"] = m["name"]
    return out


TOOL_OPEN = "<tool_call>"
TOOL_CLOSE = "</tool_call>"


class ToolStream:
    """Splits streamed model text into visible text and <tool_call>{json}</tool_call> blocks (Qwen/Hermes format)."""

    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.buf = ""
        self.in_call = False
        self.calls: list[dict] = []

    def feed(self, delta: str) -> str:
        if not self.enabled:
            return delta
        self.buf += delta
        shown = ""
        while True:
            if self.in_call:
                end = self.buf.find(TOOL_CLOSE)
                if end < 0:
                    return shown
                self._add(self.buf[:end])
                self.buf = self.buf[end + len(TOOL_CLOSE):]
                self.in_call = False
                continue
            start = self.buf.find(TOOL_OPEN)
            if start >= 0:
                shown += self.buf[:start]
                self.buf = self.buf[start + len(TOOL_OPEN):]
                self.in_call = True
                continue
            # keep back anything that could be the start of "<tool_call>"
            keep = 0
            for k in range(1, len(TOOL_OPEN)):
                if self.buf.endswith(TOOL_OPEN[:k]):
                    keep = k
            shown += self.buf[:len(self.buf) - keep]
            self.buf = self.buf[len(self.buf) - keep:]
            return shown

    def finish(self) -> str:
        rest = ""
        if self.in_call:
            self._add(self.buf)  # model stopped before </tool_call>
        else:
            rest = self.buf
        self.buf = ""
        return rest

    def _add(self, raw: str):
        raw = raw.strip()
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            m = re.search(r"\{.*\}", raw, re.S)
            try:
                obj = json.loads(m.group(0)) if m else None
            except json.JSONDecodeError:
                obj = None
        if not isinstance(obj, dict) or "name" not in obj:
            return
        args = obj.get("arguments", obj.get("parameters", {}))
        self.calls.append({
            "id": "call_" + uuid.uuid4().hex[:24],
            "type": "function",
            "function": {"name": str(obj["name"]), "arguments": args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)},
        })
