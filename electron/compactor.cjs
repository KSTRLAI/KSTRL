// Context compactor: keeps every request inside a small context window (12k tokens by default),
// so even long agent runs work on small local models.
//
// Before each model turn:
//   1. If the conversation fits, nothing happens.
//   2. Old tool output (file reads, command logs, big file writes) is trimmed — the agent can re-read files.
//   3. If it still doesn't fit, everything before the recent steps is summarised into one message
//      (goal, decisions, files changed, what's left), in chunks so the summary call fits the window too.
// Works on both message formats (Anthropic blocks and OpenAI chat messages).

const CHARS_PER_TOKEN = 3.5;
const IMAGE_TOKENS = 1600;

function strTokens(s) { return Math.ceil(String(s || '').length / CHARS_PER_TOKEN); }

function partTokens(p) {
  if (p == null) return 0;
  if (typeof p === 'string') return strTokens(p);
  if (p.type === 'image' || p.type === 'image_url') return IMAGE_TOKENS;
  if (p.type === 'text') return strTokens(p.text);
  if (p.type === 'thinking') return strTokens(p.thinking);
  if (p.type === 'redacted_thinking') return 200;
  if (p.type === 'tool_use') return strTokens(p.name) + strTokens(JSON.stringify(p.input || {}));
  if (p.type === 'tool_result') return Array.isArray(p.content) ? p.content.reduce((n, c) => n + partTokens(c), 0) : strTokens(p.content);
  return strTokens(JSON.stringify(p));
}

function msgTokens(m) {
  let n = 4;
  if (Array.isArray(m.content)) n += m.content.reduce((a, p) => a + partTokens(p), 0);
  else n += strTokens(m.content);
  if (m.tool_calls) n += strTokens(JSON.stringify(m.tool_calls));
  return n;
}

function estimate(messages, system = '', tools = []) {
  return strTokens(system) + strTokens(JSON.stringify(tools)) + messages.reduce((a, m) => a + msgTokens(m), 0);
}

// Input budget for a window: what's left after the reply.
function budgetFor(window) {
  const w = Math.max(4096, window | 0);
  const reply = Math.min(4096, Math.floor(w * 0.25));
  return { window: w, input: w - reply, reply };
}

function cut(s, max, note = 'trimmed to save context') {
  s = String(s || '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head);
  return `${s.slice(0, head)}\n…[${s.length - head - tail} characters ${note}]…\n${tail ? s.slice(-tail) : ''}`;
}

// Shorten long string fields of a tool input (e.g. write_file contents) while keeping it valid.
function shrinkInput(input, max) {
  if (!input || typeof input !== 'object') return input;
  const out = Array.isArray(input) ? [] : {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === 'string' ? cut(v, max) : v;
  return out;
}

const isToolResultMsg = (m) => m.role === 'tool' || (m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));

// Step 2: trim tool traffic in all but the last `keep` messages. Returns true if anything changed.
function trimOld(messages, keep, max) {
  let changed = false;
  const end = Math.max(0, messages.length - keep);
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { lastAssistant = i; break; }
  for (let i = 0; i < end; i++) {
    const m = messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > max) { m.content = cut(m.content, max); changed = true; }
    if (m.tool_calls) {
      for (const c of m.tool_calls) {
        const a = c.function?.arguments;
        if (typeof a === 'string' && a.length > max) {
          let next;
          try { next = JSON.stringify(shrinkInput(JSON.parse(a), max)); } catch { next = JSON.stringify({ note: 'arguments trimmed to save context' }); }
          if (next.length < a.length) { c.function.arguments = next; changed = true; }
        }
      }
    }
    if (Array.isArray(m.content)) {
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j];
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content) ? b.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : String(b.content ?? '');
          const hasImg = Array.isArray(b.content) && b.content.some((c) => c.type === 'image');
          if (text.length > max || hasImg) { b.content = cut(text, max); changed = true; }
        } else if (b.type === 'tool_use') {
          const s = JSON.stringify(b.input || {});
          if (s.length > max) { b.input = shrinkInput(b.input, max); changed = true; }
        } else if (b.type === 'text' && m.role === 'user' && b.text.length > max * 4) {
          b.text = cut(b.text, max * 4); changed = true;
        } else if ((b.type === 'thinking' || b.type === 'redacted_thinking') && i !== lastAssistant) {
          // Old thinking can be dropped; the latest assistant turn keeps it (the API needs it to continue a tool loop).
          m.content.splice(j--, 1); changed = true;
        } else if (b.type === 'image' || b.type === 'image_url') {
          m.content[j] = { type: 'text', text: '[an image was attached here]' }; changed = true;
        }
      }
      if (!m.content.length) m.content = [{ type: 'text', text: '…' }];
    }
  }
  return changed;
}

// Plain-text transcript of messages, for the summariser.
function render(messages, perItem = 1200) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'tool') { lines.push(`[tool result] ${cut(m.content, perItem)}`); continue; }
    const who = m.role === 'user' ? 'USER' : 'ASSISTANT';
    if (typeof m.content === 'string') { if (m.content) lines.push(`${who}: ${cut(m.content, perItem * 3)}`); }
    else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text) lines.push(`${who}: ${cut(b.text, perItem * 3)}`);
        else if (b.type === 'tool_use') lines.push(`[tool call] ${b.name} ${cut(JSON.stringify(b.input || {}), perItem)}`);
        else if (b.type === 'tool_result') lines.push(`[tool result] ${cut(Array.isArray(b.content) ? b.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') : b.content, perItem)}`);
        else if (b.type === 'image' || b.type === 'image_url') lines.push(`${who}: [image]`);
      }
    }
    for (const c of m.tool_calls || []) lines.push(`[tool call] ${c.function?.name} ${cut(c.function?.arguments, perItem)}`);
  }
  return lines.join('\n');
}

const SUMMARY_SYSTEM = 'You compress the history of a coding session so the work can continue with a small context window. Write a dense summary in plain text with these sections:\nGOAL: what the user wants overall (keep their exact requirements).\nDONE: what has been done so far — files created/changed (paths) and key decisions.\nSTATE: important facts learned (APIs, file structure, errors and fixes, commands that work).\nNEXT: what remains to do.\nNo filler. Keep file paths, names and numbers exact. At most about 350 words.';

// Fallback when the summariser can't run (offline / out of usage): keep the user's words and the tool calls.
function mechanicalSummary(messages, maxChars) {
  const reqs = [];
  const acts = [];
  for (const m of messages) {
    const texts = typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text) : [];
    if (m.role === 'user' && !isToolResultMsg(m)) for (const t of texts) if (t) reqs.push(cut(t, 600));
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_use') acts.push(`${b.name} ${b.input?.path || b.input?.command || b.input?.query || ''}`.trim());
    for (const c of m.tool_calls || []) { let a = {}; try { a = JSON.parse(c.function.arguments); } catch {} acts.push(`${c.function?.name} ${a.path || a.command || a.query || ''}`.trim()); }
  }
  return cut(`User requests so far:\n${reqs.map((r) => '- ' + r).join('\n')}\n\nActions taken:\n${[...new Set(acts)].slice(-60).map((a) => '- ' + a).join('\n')}`, maxChars);
}

async function summarise(messages, budget, quick) {
  const chunkChars = Math.floor(budget.input * 0.55 * CHARS_PER_TOKEN);
  const maxSummaryChars = Math.floor(Math.min(1800, budget.input * 0.18) * CHARS_PER_TOKEN);
  const text = render(messages);
  let summary = '';
  try {
    for (let i = 0; i < text.length; i += chunkChars) {
      const part = text.slice(i, i + chunkChars);
      const user = (summary ? `Summary so far:\n${summary}\n\nMore of the session:\n` : 'Session:\n') + part + '\n\nWrite the updated summary.';
      const out = await quick({ system: SUMMARY_SYSTEM, user, maxTokens: Math.min(900, Math.floor(budget.input * 0.15)) });
      if (!out || !out.trim()) throw new Error('empty summary');
      summary = out.trim();
    }
    return cut(summary, maxSummaryChars);
  } catch {
    return mechanicalSummary(messages, maxSummaryChars);
  }
}

function latestUserRequest(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user' || isToolResultMsg(m)) continue;
    const t = typeof m.content === 'string' ? m.content : (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t && t.startsWith('[Earlier work, summarised')) { // carry the original request through repeated compactions
      const m2 = t.match(/The user's current request \(verbatim\):\n([\s\S]*?)\n\nContinue from here\./);
      if (m2) return m2[1];
      continue;
    }
    if (t) return t;
  }
  return '';
}

/**
 * Makes chat.messages fit the window. Mutates the array in place.
 * opts: { window, system, tools, quick(system,user,maxTokens) → text, ratio (measured tokens ÷ estimate) }
 * Returns null when nothing was needed, or { before, after, summarised }.
 */
async function fit(messages, { window, system, tools, quick, ratio = 1 }) {
  const budget = budgetFor(window);
  const r = Math.min(2.5, Math.max(0.6, ratio || 1));
  const size = () => Math.ceil(estimate(messages, system, tools) * r);
  const fixed = Math.ceil((strTokens(system) + strTokens(JSON.stringify(tools))) * r);
  const target = Math.floor(budget.input * 0.85);
  const before = size();
  if (before <= target) return null;

  // 2. Trim old tool output, then (if needed) everything except the very last step.
  const perItem = Math.max(400, Math.floor((budget.input - fixed) * 0.12 * CHARS_PER_TOKEN));
  trimOld(messages, 4, perItem);
  if (size() > target) trimOld(messages, 1, Math.floor(perItem / 2));
  if (size() <= target) return { before, after: size(), summarised: false };

  // 3. Summarise the head. The tail starts at an assistant message so the result stays a valid conversation:
  //    [user: summary + current request] [assistant …] [tool results …] …
  const tailBudget = Math.max(0, Math.floor((budget.input - fixed) * 0.45));
  let start = -1;
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role !== 'assistant') continue;
    const t = Math.ceil(messages.slice(i).reduce((a, m) => a + msgTokens(m), 0) * r);
    if (t > tailBudget && start !== -1) break;
    start = i;
    if (t > tailBudget) break; // even the last step alone is big: keep just it, trimmed below
  }
  if (start === -1) { // a single huge message: nothing to summarise, just trim it
    trimOld(messages, 0, Math.floor(perItem / 2));
    return { before, after: size(), summarised: false };
  }
  const request = latestUserRequest(messages);
  const head = messages.slice(0, start);
  const tail = messages.slice(start);
  const summary = await summarise(head, budget, quick);
  const requestInHead = head.some((m) => latestUserRequest([m]) === request);
  const intro = `[Earlier work, summarised to fit the context window]\n${summary}` +
    (request && requestInHead ? `\n\nThe user's current request (verbatim):\n${cut(request, Math.floor(budget.input * 0.1 * CHARS_PER_TOKEN))}` : '') +
    '\n\nContinue from here. Re-read files if you need their exact contents.';
  const anthropicStyle = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result' || b.type === 'text'));
  const fresh = [{ role: 'user', content: anthropicStyle ? [{ type: 'text', text: intro }] : intro }];
  messages.splice(0, messages.length, ...fresh, ...tail);

  // Last resort: the remaining step is still too big — trim its tool output hard.
  if (size() > budget.input) trimOld(messages, 0, Math.max(300, Math.floor((budget.input - fixed - (size() - fixed) * 0.1) * 0.25 * CHARS_PER_TOKEN / Math.max(1, messages.length))));
  return { before, after: size(), summarised: true };
}

// Caps one new tool result so a single huge file read can't blow the window.
function capResult(text, window) {
  const budget = budgetFor(window);
  const max = Math.max(2000, Math.floor(budget.input * 0.3 * CHARS_PER_TOKEN));
  return String(text).length > max ? cut(text, max, 'cut to fit the context window — read a smaller line range or search instead') : text;
}

module.exports = { fit, estimate, budgetFor, capResult, render, mechanicalSummary };
