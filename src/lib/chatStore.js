// Shared chat store: one source of truth for the Home view and the IDE agent panel.
import { useSyncExternalStore } from 'react';

const api = window.kstrl;
let seq = 0;
export const uid = (p) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`; // unique across windows

const newChatObj = (project = null) => ({ id: uid('chat'), title: 'New chat', project, items: [], running: false, runId: null, createdAt: Date.now() });

let state = (() => { const c = newChatObj(); return { chats: [c], activeId: c.id, history: [c.id], historyIndex: 0 }; })();
const listeners = new Set();
const set = (fn) => { state = fn(state); listeners.forEach((l) => l()); scheduleSave(); };

// ---- persistence: each window keeps its own chat list on disk ----
const KIND = window.location.hash === '#ide' ? 'ide' : 'home';
let loaded = false;
let saveTimer = null;
const clip = (t, n) => (typeof t === 'string' && t.length > n ? t.slice(0, n) + '\n…(truncated)' : t);
function serialize(s) {
  const chats = s.chats.filter((c) => c.items.length).slice(0, 60).map((c) => ({
    ...c,
    running: false,
    runId: null,
    items: c.items.map((it) => (it.type !== 'assistant' ? it : {
      ...it,
      running: false,
      blocks: it.blocks.map((b) => (b.kind !== 'tool' ? b : {
        ...b,
        approval: null,
        live: undefined,
        output: clip(b.output, 4000),
        status: ['pending', 'running', 'approval'].includes(b.status) ? 'err' : b.status,
        summary: ['pending', 'running', 'approval'].includes(b.status) ? 'interrupted' : b.summary,
      })),
    })),
  }));
  return { version: 1, chats, activeId: s.activeId };
}
function scheduleSave() {
  if (!loaded) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.chats.save(KIND, serialize(state)).catch(() => {}), 800);
}
window.addEventListener('beforeunload', () => { if (loaded) api.chats.save(KIND, serialize(state)); });
api.chats.load(KIND).then((data) => {
  const saved = data && Array.isArray(data.chats) ? serialize({ chats: data.chats, activeId: data.activeId }).chats : [];
  if (saved.length) {
    // Keep whatever was started before the load finished, then the saved chats.
    const fresh = state.chats.filter((c) => c.items.length || c.running);
    const blank = newChatObj(activeChat().project);
    state = { ...state, chats: [...(fresh.length ? fresh : [blank]), ...saved.filter((c) => !fresh.some((f) => f.id === c.id))], activeId: fresh.length ? state.activeId : blank.id };
    state.history = [state.activeId];
    state.historyIndex = 0;
    listeners.forEach((l) => l());
  }
  loaded = true;
}).catch(() => { loaded = true; });

// Earlier turns of a chat as plain text, so Kestrel keeps the conversation after a restart.
function transcript(chat) {
  const out = [];
  for (const it of chat.items) {
    if (it.type === 'user') out.push({ role: 'user', text: clip(it.text, 8000) });
    else if (it.type === 'assistant') out.push({ role: 'assistant', text: clip(it.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n'), 8000) || '(no reply)' });
  }
  return out.slice(-40);
}
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

export function useChats() {
  return useSyncExternalStore(subscribe, () => state);
}
export const getState = () => state;
export const activeChat = (s = state) => s.chats.find((c) => c.id === s.activeId) || s.chats[0];

const patchChat = (chatId, fn) => set((s) => ({ ...s, chats: s.chats.map((c) => (c.id === chatId ? fn(c) : c)) }));
const patchRun = (chatId, runId, fn) => patchChat(chatId, (c) => ({ ...c, items: c.items.map((it) => (it.type === 'assistant' && it.runId === runId ? fn(it) : it)) }));
const patchTool = (chatId, toolId, fn) => patchChat(chatId, (c) => ({
  ...c,
  items: c.items.map((it) => (it.type !== 'assistant' ? it : { ...it, blocks: it.blocks.map((b) => (b.kind === 'tool' && b.toolId === toolId ? fn(b) : b)) })),
}));

function pushHistory(s, id) {
  const h = s.history.slice(0, s.historyIndex + 1).filter((x) => x !== id);
  h.push(id);
  return { history: h.slice(-50), historyIndex: Math.min(h.length, 50) - 1 };
}

export const chats = {
  setActive(id) { set((s) => ({ ...s, activeId: id, ...pushHistory(s, id) })); },
  back() { set((s) => { const i = s.historyIndex - 1; const id = s.history[i]; return i >= 0 && s.chats.some((c) => c.id === id) ? { ...s, historyIndex: i, activeId: id } : s; }); },
  forward() { set((s) => { const i = s.historyIndex + 1; const id = s.history[i]; return i < s.history.length && s.chats.some((c) => c.id === id) ? { ...s, historyIndex: i, activeId: id } : s; }); },
  canBack: (s) => s.historyIndex > 0,
  canForward: (s) => s.historyIndex < s.history.length - 1,
  newChat(project = null) {
    set((s) => {
      const cur = activeChat(s);
      if (cur && cur.items.length === 0 && !cur.running) {
        const c = { ...cur, project };
        return { ...s, chats: s.chats.map((x) => (x.id === cur.id ? c : x)) };
      }
      const c = newChatObj(project);
      return { ...s, chats: [c, ...s.chats.filter((x) => x.items.length || x.running)].slice(0, 60), activeId: c.id, ...pushHistory(s, c.id) };
    });
  },
  close(id) {
    api.agent.reset(id);
    set((s) => {
      let list = s.chats.filter((c) => c.id !== id);
      if (!list.length) list = [newChatObj()];
      return { ...s, chats: list, activeId: s.activeId === id ? list[0].id : s.activeId, history: s.history.filter((x) => x !== id), historyIndex: Math.max(0, s.history.filter((x) => x !== id).length - 1) };
    });
  },
  setProject(project) {
    set((s) => ({ ...s, chats: s.chats.map((c) => (c.id === s.activeId && c.items.length === 0 ? { ...c, project } : c)) }));
  },
  async send({ text, title, context = [], model, effort, mode, activePath, project }) {
    const chat = activeChat();
    if (!text.trim() || chat.running) return;
    let full = text;
    const parts = [];
    for (const c of context) {
      if (c.kind === 'selection') parts.push(`<selection path="${c.path}" lines="${c.startLine}-${c.endLine}">\n${c.text}\n</selection>`);
      else {
        try {
          const body = await api.fs.readFile(c.path);
          parts.push(`<file path="${c.path}">\n${body.length > 120000 ? body.slice(0, 120000) + '\n…(truncated)' : body}\n</file>`);
        } catch { parts.push(`<file path="${c.path}">(could not be read)</file>`); }
      }
    }
    if (activePath) parts.push(`<editor_state>The user currently has ${activePath} open in the editor.</editor_state>`);
    if (parts.length) full = `${text}\n\n${parts.join('\n\n')}`;
    const runId = uid('run');
    const history = transcript(chat);
    patchChat(chat.id, (c) => ({
      ...c,
      project: c.project ?? project ?? null,
      title: c.items.length === 0 ? (title || text.slice(0, 60)) : c.title,
      running: true,
      runId,
      items: [...c.items, { type: 'user', text, context }, { type: 'assistant', runId, blocks: [], running: true, model: model?.name, mode }],
    }));
    api.agent.run({ chatId: chat.id, runId, text: full, model: model?.id, effort: effort?.id, mode, history });
  },
  stop(id) { api.agent.stop(id || activeChat().id); },
  approve(chatId, block, ok) {
    api.agent.approve(block.approval, ok);
    patchTool(chatId, block.toolId, (b) => ({ ...b, approval: null, status: ok ? 'running' : 'err' }));
  },
  async revert(chatId, runId) {
    const r = await api.agent.revert(runId);
    patchRun(chatId, runId, (it) => ({ ...it, reverted: true }));
    return r;
  },
};

// Agent events from the main process.
api.agent.onEvent((ev) => {
  const { chatId, runId } = ev;
  const upd = (fn) => patchRun(chatId, runId, fn);
  switch (ev.type) {
    case 'text':
    case 'thinking': {
      const kind = ev.type;
      upd((it) => {
        const blocks = [...it.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === kind) blocks[blocks.length - 1] = { ...last, text: last.text + ev.delta };
        else blocks.push({ kind, text: ev.delta });
        return { ...it, blocks };
      });
      break;
    }
    case 'tool_pending':
      upd((it) => ({ ...it, blocks: [...it.blocks, { kind: 'tool', toolId: ev.toolId, name: ev.name, status: 'pending' }] }));
      break;
    case 'tool_start':
      upd((it) => (it.blocks.some((b) => b.toolId === ev.toolId)
        ? { ...it, blocks: it.blocks.map((b) => (b.toolId === ev.toolId ? { ...b, input: ev.input, status: 'running' } : b)) }
        : { ...it, blocks: [...it.blocks, { kind: 'tool', toolId: ev.toolId, name: ev.name, input: ev.input, status: 'running' }] }));
      break;
    case 'approval':
      patchTool(chatId, ev.toolId, (b) => ({ ...b, approval: ev.id, status: 'approval' }));
      break;
    case 'tool_output':
      patchTool(chatId, ev.toolId, (b) => ({ ...b, live: ((b.live || '') + ev.data).slice(-40000) }));
      break;
    case 'tool_end':
      patchTool(chatId, ev.toolId, (b) => ({ ...b, status: ev.ok ? 'ok' : 'err', summary: ev.summary, diff: ev.diff, output: ev.output, approval: null }));
      break;
    case 'notice':
      upd((it) => ({ ...it, blocks: [...it.blocks, { kind: 'notice', text: ev.message }] }));
      break;
    case 'error':
      upd((it) => ({ ...it, blocks: [...it.blocks, { kind: 'error', text: ev.message }] }));
      break;
    case 'usage':
      upd((it) => ({ ...it, tokens: (it.tokens || 0) + (ev.usage.output_tokens || 0) }));
      break;
    case 'done':
      upd((it) => ({ ...it, running: false, blocks: it.blocks.map((b) => (b.kind === 'tool' && ['pending', 'running', 'approval'].includes(b.status) ? { ...b, status: 'err', approval: null, summary: b.summary || 'stopped' } : b)) }));
      patchChat(chatId, (c) => ({ ...c, running: false, runId: null }));
      break;
    default:
  }
});
