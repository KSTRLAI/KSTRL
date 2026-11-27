// Tab autocomplete: grey inline suggestions from Colossus 2.1, accepted with Tab.
import { monaco } from './monaco.js';

const api = window.kstrl;
let enabled = true;
let seq = 0;
export const setAutocomplete = (on) => { enabled = on !== false; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = new Map(); // prefix tail → suggestion

monaco.languages.registerInlineCompletionsProvider('*', {
  async provideInlineCompletions(model, position, context, token) {
    if (!enabled || !model.uri.path.startsWith('/workspace/')) return { items: [] };
    const line = model.getLineContent(position.lineNumber);
    const after = line.slice(position.column - 1);
    if (/[^\s)\]}'"`;,]/.test(after)) return { items: [] }; // mid-word or before code: stay quiet
    const startLine = Math.max(1, position.lineNumber - 80);
    const prefix = model.getValueInRange(new monaco.Range(startLine, 1, position.lineNumber, position.column)).slice(-6000);
    if (!prefix.trim()) return { items: [] };
    const endLine = Math.min(model.getLineCount(), position.lineNumber + 30);
    const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, endLine, model.getLineMaxColumn(endLine))).slice(0, 2000);
    const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
    const key = prefix.slice(-400) + '\u0000' + suffix.slice(0, 80);
    if (cache.has(key)) return { items: cache.get(key) ? [{ insertText: cache.get(key), range }] : [] };

    // Wait for a pause in typing; a newer keystroke cancels this request.
    await sleep(context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit ? 0 : 350);
    if (token.isCancellationRequested) return { items: [] };
    const id = ++seq;
    const sub = token.onCancellationRequested(() => api.agent.cancelComplete(id));
    let text = '';
    try { text = await api.agent.complete({ id, prefix, suffix, language: model.getLanguageId(), path: model.uri.path.replace('/workspace/', '') }); }
    catch { text = ''; }
    finally { sub.dispose(); }
    if (token.isCancellationRequested) return { items: [] };
    cache.set(key, text);
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return { items: text ? [{ insertText: text, range }] : [] };
  },
  freeInlineCompletions() {},
  disposeInlineCompletions() {},
});
