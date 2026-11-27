// OpenAI-compatible streaming client (Unsloth server, llama.cpp, vLLM, Ollama, LM Studio…).
// Streams text, reasoning and tool calls; splits <think>…</think> blocks out of the content.

class ProviderError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function normalizeBase(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new ProviderError(0, 'No Unsloth server URL configured. Add it in Settings → Model Server.');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  u = u.replace(/\/chat\/completions$/, '');
  if (!/\/v\d+$/.test(u)) u += '/v1';
  return u;
}

function headers(apiKey) {
  const h = { 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  if (apiKey) h.authorization = `Bearer ${apiKey}`;
  return h;
}

async function listModels({ baseURL, apiKey, signal }) {
  const base = normalizeBase(baseURL);
  let res;
  try { res = await fetch(`${base}/models`, { headers: headers(apiKey), signal }); }
  catch (e) { throw new ProviderError(0, `Could not reach ${base} (${e.cause?.code || e.message}).`); }
  if (!res.ok) throw new ProviderError(res.status, `Server answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name || m.model)).filter(Boolean);
}

// Splits streamed content into visible text and <think> reasoning, across chunk boundaries.
function thinkSplitter(onText, onThinking) {
  let inThink = false;
  let carry = '';
  return (chunk) => {
    let s = carry + chunk;
    carry = '';
    while (s) {
      const tag = inThink ? '</think>' : '<think>';
      const i = s.indexOf(tag);
      if (i === -1) {
        // keep a possible partial tag for the next chunk
        let keep = 0;
        for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) if (tag.startsWith(s.slice(-k))) { keep = k; break; }
        const out = s.slice(0, s.length - keep);
        carry = s.slice(s.length - keep);
        if (out) (inThink ? onThinking : onText)(out);
        return;
      }
      const out = s.slice(0, i);
      if (out) (inThink ? onThinking : onText)(out);
      inThink = !inThink;
      s = s.slice(i + tag.length);
    }
  };
}

async function streamChat({ baseURL, apiKey, body, signal, onText, onThinking, onToolStart, extraHeaders }) {
  const base = normalizeBase(baseURL);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { ...headers(apiKey), ...(extraHeaders || {}) }, body: JSON.stringify({ ...body, stream: true }), signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new ProviderError(0, `Could not reach the Unsloth server at ${base} (${e.cause?.code || e.message}).`);
  }
  if (!res.ok && res.status === 400 && body.stream_options) {
    // Older servers reject stream_options — retry once without it.
    const t = await res.clone().text().catch(() => '');
    if (/stream_options|include_usage/i.test(t)) {
      const { stream_options, ...rest } = body;
      return streamChat({ baseURL, apiKey, body: rest, signal, onText, onThinking, onToolStart, extraHeaders });
    }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    let msg = t;
    try { const j = JSON.parse(t); msg = j.error?.message || j.detail || j.message || t; } catch {}
    throw new ProviderError(res.status, String(msg).slice(0, 500));
  }

  let text = '';
  let reasoning = '';
  const calls = [];
  let finish = null;
  let usage = null;
  const split = thinkSplitter((t) => { text += t; onText(t); }, (t) => { reasoning += t; onThinking(t); });

  const handle = (j) => {
    if (j.usage) usage = j.usage;
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    const d = ch.delta || ch.message || {};
    const r = d.reasoning_content ?? d.reasoning;
    if (r) { reasoning += r; onThinking(r); }
    if (d.content) split(d.content);
    for (const tc of d.tool_calls || []) {
      const idx = tc.index ?? calls.length;
      if (!calls[idx]) calls[idx] = { id: '', name: '', args: '', announced: false };
      const c = calls[idx];
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      if (c.name && !c.announced) { c.announced = true; if (!c.id) c.id = `call_${Date.now().toString(36)}_${idx}`; onToolStart(c.id, c.name); }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('event-stream')) {
    // Server ignored stream:true — handle a single JSON body.
    handle(await res.json());
  } else {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try { handle(JSON.parse(data)); } catch {}
      }
    }
  }
  split('');

  const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, rawArgs: c.args || '{}' }));
  return { text, reasoning, toolCalls, finish, usage };
}

module.exports = { streamChat, listModels, normalizeBase, ProviderError };
