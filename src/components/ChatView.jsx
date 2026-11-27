import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fmtKbd, mod } from '../lib/keys.js';
import {
  ArrowUp, Square, Plus, X, ChevronDown, Check, Brain, FileCode2, Terminal as TermIcon, Search, FolderTree, FilePen,
  FilePlus2, Loader2, CircleAlert, CircleCheck, CircleX, Infinity as InfinityIcon, MessageCircleQuestion, AtSign, Zap,
  Gauge, Flame, Rocket, RotateCcw, Eye, History, PanelRightClose, Copy, Monitor, FolderPlus, FolderOpen, Folder,
  Hammer, ListChecks, Bug, Compass, Code2, ScanSearch, Globe, ImageIcon,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { renderMarkdown } from '../lib/markdown.js';
import { useChats, chats as store, activeChat } from '../lib/chatStore.js';
import { ModelMenu, resolveModel, modelParts, runLabel } from './ModelPicker.jsx';

const api = window.kstrl;
const EFFORT_ICON = { flash: Zap, normal: Gauge, high: Flame, max: Rocket, ultracode: Code2 };
export const MODES = [
  { id: 'build', name: 'Build', I: Hammer, d: 'Builds it: edits files and runs commands to finish the task.' },
  { id: 'plan', name: 'Plan', I: ListChecks, d: 'Plan and brainstorm before building. Uses Colossus 2.1 to save usage.' },
  { id: 'ask', name: 'Ask', I: MessageCircleQuestion, d: 'Reads and explains your code. Never changes anything.' },
];
export const nextMode = (m) => MODES[(MODES.findIndex((x) => x.id === m) + 1) % MODES.length].id;

// White dots that pulse while Kestrel is thinking.
export function ThinkingDots({ label = 'Thinking' }) {
  return <div className="thinking-dots" role="status"><span className="dots"><i /><i /><i /></span>{label && <span className="lbl">{label}</span>}</div>;
}

const TOOL_ICON = { list_files: FolderTree, read_file: FileCode2, search: Search, codebase_search: ScanSearch, write_file: FilePlus2, edit_file: FilePen, run_command: TermIcon, web_search: Globe, fetch_url: Globe };
const TOOL_VERB = { list_files: 'List', read_file: 'Read', search: 'Search', codebase_search: 'Search code', write_file: 'Write', edit_file: 'Edit', run_command: 'Run', web_search: 'Web search', fetch_url: 'Read page' };

// Pasted screenshots: shrink to at most 1568px (what vision models use) and keep a small thumbnail for the chat.
async function imageItem(file) {
  const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const draw = (max, type, q) => {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(type, q);
  };
  const type = file.type === 'image/png' && file.size < 1_500_000 ? 'image/png' : 'image/jpeg';
  const full = draw(1568, type, 0.88);
  return { kind: 'image', name: file.name && file.name !== 'image.png' ? file.name : 'Screenshot', mediaType: type, data: full.split(',')[1], thumb: draw(160, 'image/jpeg', 0.8), path: `image-${Date.now()}-${Math.random().toString(36).slice(2)}` };
}

function lineDiffStat(before, after) {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) || 0) + 1);
  let common = 0;
  for (const l of b) { const c = counts.get(l); if (c) { common++; counts.set(l, c - 1); } }
  return { added: b.length - common, removed: a.length - common };
}

function toolArg(name, input) {
  if (!input) return '';
  if (name === 'run_command') return input.command;
  if (name === 'search' || name === 'codebase_search' || name === 'web_search') return input.query;
  if (name === 'fetch_url') return input.url;
  if (name === 'list_files') return input.path || '.';
  return input.path || '';
}

function Markdown({ text }) {
  const ref = useRef(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy-code')) return;
      const b = document.createElement('button');
      b.className = 'copy-code';
      b.textContent = 'COPY';
      b.onclick = () => { navigator.clipboard.writeText(pre.querySelector('code')?.innerText || pre.innerText); b.textContent = 'COPIED'; setTimeout(() => (b.textContent = 'COPY'), 1200); };
      pre.appendChild(b);
    });
    ref.current?.querySelectorAll('a').forEach((a) => { a.onclick = (e) => { e.preventDefault(); api.shell.openExternal(a.href); }; });
  }, [html]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolCard({ block, onApprove, onOpenDiff, onOpenFile }) {
  const [open, setOpen] = useState(block.name === 'run_command');
  const Icon = TOOL_ICON[block.name] || FileCode2;
  const st = block.status;
  const stat = block.diff ? lineDiffStat(block.diff.before, block.diff.after) : null;
  const arg = toolArg(block.name, block.input);
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => (block.diff ? onOpenDiff(block.diff) : block.name === 'read_file' && block.input?.path ? onOpenFile(block.input.path) : setOpen(!open))}>
        <span className={'st ' + (st === 'ok' ? 'ok' : st === 'err' ? 'err' : '')}>
          {st === 'ok' ? <CircleCheck size={13} /> : st === 'err' ? <CircleX size={13} /> : st === 'approval' ? <CircleAlert size={13} color="var(--warn)" /> : <Loader2 size={13} className="spin" />}
        </span>
        <Icon size={13} color="var(--text-3)" />
        <span className="nm">{TOOL_VERB[block.name] || block.name}</span>
        <span className="arg">{arg || (st === 'pending' ? '…' : '')}</span>
        {stat ? <span className="diffstat"><span className="a">+{stat.added}</span> <span className="r">-{stat.removed}</span></span> : block.summary && <span className="sum">{block.summary}</span>}
        {block.name === 'run_command' && <ChevronDown size={13} style={{ transform: open ? 'rotate(180deg)' : 'none', color: 'var(--text-3)' }} onClick={(e) => { e.stopPropagation(); setOpen(!open); }} />}
      </div>
      {block.approval && (
        <div className="approval">
          <div className="label" style={{ color: 'var(--accent)' }}>{block.approvalKind === 'web' ? 'Allow web access?' : 'Run this command?'}</div>
          <code>{block.approvalText || block.input?.command}</code>
          <div className="row">
            <button className="btn light" onClick={() => onApprove(block, true)}>{block.approvalKind === 'web' ? 'Allow' : 'Run'}</button>
            <button className="btn" onClick={() => onApprove(block, false)}>Skip</button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center' }}>{block.approvalKind === 'web' ? 'Web access can be set to Always in Settings' : 'Auto-run can be enabled in Settings'}</span>
          </div>
        </div>
      )}
      {open && block.name === 'run_command' && (block.output || block.live) && (
        <div className="tool-body">{(block.output || block.live || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(-20000)}</div>
      )}
    </div>
  );
}

function ChangesCard({ item, onOpenDiff, onRevert }) {
  const files = useMemo(() => {
    const m = new Map();
    for (const b of item.blocks) {
      if (b.kind !== 'tool' || !b.diff) continue;
      const prev = m.get(b.diff.path);
      m.set(b.diff.path, { path: b.diff.path, before: prev ? prev.before : b.diff.before, after: b.diff.after });
    }
    return [...m.values()];
  }, [item.blocks]);
  if (!files.length) return null;
  return (
    <div className="changes glass-soft">
      <div className="changes-head">
        <span className="label">{files.length} file{files.length > 1 ? 's' : ''} changed</span>
        {item.reverted ? <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Reverted</span> : <button className="btn ghost" style={{ height: 24 }} onClick={onRevert}><RotateCcw size={12} /> Revert all</button>}
      </div>
      {files.map((f) => {
        const s = lineDiffStat(f.before, f.after);
        return (
          <div key={f.path} className="changes-row" onClick={() => onOpenDiff(f)}>
            <FileCode2 size={13} color="var(--text-3)" />
            <span className="p">{f.path}</span>
            <span className="diffstat"><span className="a">+{s.added}</span> <span className="r">-{s.removed}</span></span>
            <Eye size={13} color="var(--text-3)" />
          </div>
        );
      })}
    </div>
  );
}

export function Popover({ anchor, onClose, children, width = 300, below = false, align = 'left' }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const h = ref.current?.offsetHeight || 200;
      const left = Math.min(Math.max(8, align === 'right' ? r.right - width : r.left), window.innerWidth - width - 8);
      let top = below || r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6;
      top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
      setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [anchor, width, below, align]);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [anchor, onClose]);
  // Portal to <body>: glass panes use backdrop-filter, which would otherwise become the containing block for position:fixed.
  return createPortal(<div ref={ref} className="popover glass-strong" style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>{children}</div>, document.body);
}

const TIPS = [
  ['Ctrl+K', 'in the editor rewrites the selected code inline'],
  ['Ctrl+L', 'sends your selection to Kestrel'],
  ['@', 'attaches files from your project to a message'],
  ['Ctrl+.', 'cycles between Build, Plan and Ask'],
  ['Plan', 'mode brainstorms with you first and uses less of your daily usage'],
  ['Auto', 'in the model picker chooses the right Colossus model for you'],
  ['Automations', 'run Kestrel on a schedule — find them in the sidebar'],
  ['Ctrl+E', 'opens the IDE in its own window'],
  ['Ctrl+Shift+P', 'opens the command palette with every action'],
];

function Tip() {
  const [i, setI] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % TIPS.length), 9000); return () => clearInterval(t); }, []);
  const [k, d] = TIPS[i];
  return <div className="tip">Tip: <b>{k}</b> {d}</div>;
}

const SUGGESTIONS = [
  { I: Hammer, t: 'Build a prototype', d: 'Describe an app and Kestrel scaffolds it', prompt: 'Build a prototype of ', mode: 'build' },
  { I: ListChecks, t: 'Start with a plan', d: 'Brainstorm and agree on a plan before writing code', prompt: 'Help me plan: ', mode: 'plan' },
  { I: Bug, t: 'Debug an issue', d: 'Find root causes and fix tricky bugs', prompt: 'Help me debug this issue: ', mode: 'build' },
  { I: Compass, t: 'Explain this codebase', d: 'Get a tour of how the project fits together', prompt: 'Give me a tour of this codebase: the structure, the main modules and how they fit together.', mode: 'ask', send: true },
];

const ChatView = forwardRef(function ChatView(props, ref) {
  const { variant = 'panel', info, settings, onSettings, workspace, activePath, files, onOpenFile, onOpenDiff, onClosePanel, onOpenSettings, onToast, project } = props;
  const s = useChats();
  const chat = activeChat(s);
  const [input, setInput] = useState('');
  const [context, setContext] = useState([]);
  const [pop, setPop] = useState(null);
  const [mention, setMention] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const taRef = useRef(null);
  const scrollRef = useRef(null);
  const stick = useRef(true);

  const models = info?.models || [];
  const efforts = info?.efforts || [];
  const parts = modelParts(info, settings);
  const label = parts.effort ? `${parts.name} ${parts.effort}` : parts.name;
  const effort = efforts.find((e) => e.id === settings.effort) || efforts[1];
  const mode = MODES.some((m) => m.id === settings.mode) ? settings.mode : 'build';
  const modeDef = MODES.find((m) => m.id === mode);
  const usage = settings.usageToday;
  const outOfUsage = !!usage && usage.left <= 0;
  const EffortIcon = EFFORT_ICON[effort?.id] || Gauge;
  const isHome = variant === 'home';
  const hero = isHome && chat.items.length === 0;

  useLayoutEffect(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [chat]);
  useLayoutEffect(() => { const ta = taRef.current; if (!ta) return; ta.style.height = 'auto'; const max = hero ? 260 : 220; ta.style.height = Math.min(max, ta.scrollHeight) + 'px'; ta.style.overflowY = ta.scrollHeight > max ? 'auto' : 'hidden'; }, [input, hero]);
  useEffect(() => { setContext([]); stick.current = true; }, [chat.id]);

  const addContext = useCallback((c) => {
    setContext((cs) => (cs.some((x) => x.kind === c.kind && x.path === c.path && x.startLine === c.startLine) ? cs : [...cs, c]));
    setTimeout(() => taRef.current?.focus(), 0);
  }, []);

  const focus = () => taRef.current?.focus();
  const addImages = async (files) => {
    for (const f of files.slice(0, 6)) {
      try { addContext(await imageItem(f)); } catch { onToast?.('Could not read that image'); }
    }
  };
  const onPaste = (e) => {
    const imgs = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (imgs.length) { e.preventDefault(); addImages(imgs); }
  };
  useImperativeHandle(ref, () => ({ focus, addContext, setInput: (t) => { setInput(t); setTimeout(focus, 0); } }));

  const send = async (override, modeOverride) => {
    const text = (override ?? input).trim();
    if (!text || chat.running || outOfUsage) return;
    const mode = modeOverride || modeDef.id;
    const ctx = context;
    setInput('');
    setContext([]);
    setMention(null);
    stick.current = true;
    if (!settings.onboarded) onSettings({ onboarded: true });
    const { model, auto } = resolveModel(info, settings, { text, contextCount: ctx.length, mode });
    store.send({ text, context: ctx, model: model && { id: model.id, name: runLabel(info, settings, model, auto) }, effort, mode, activePath, project: workspace?.root ?? null });
  };

  const revert = async (item) => {
    const r = await store.revert(chat.id, item.runId);
    onToast(`Reverted ${r.reverted} file${r.reverted === 1 ? '' : 's'}`);
  };

  const mentionResults = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(q)).sort((a, b) => a.length - b.length).slice(0, 8);
  }, [mention, files]);

  const onInput = (e) => {
    const v = e.target.value;
    setInput(v);
    const m = v.slice(0, e.target.selectionStart).match(/(?:^|\s)@([^\s@]*)$/);
    setMention(m && workspace ? { query: m[1], sel: 0 } : null);
  };

  const pickMention = (path) => {
    const caret = taRef.current.selectionStart;
    setInput(input.slice(0, caret).replace(/@([^\s@]*)$/, '') + input.slice(caret));
    setMention(null);
    addContext({ kind: 'file', path });
  };

  const onKeyDown = (e) => {
    if (mention && mentionResults.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMention((m) => ({ ...m, sel: Math.min(mentionResults.length - 1, m.sel + 1) })); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMention((m) => ({ ...m, sel: Math.max(0, m.sel - 1) })); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionResults[mention.sel]); return; }
      if (e.key === 'Escape') { setMention(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && chat.running) store.stop(chat.id);
    if (e.key === '.' && mod(e)) { e.preventDefault(); onSettings({ mode: nextMode(mode) }); }
  };

  const openAt = (kind) => (e) => setPop({ kind, anchor: e.currentTarget });

  // ---------- pieces ----------
  const mentionList = mention && mentionResults.length > 0 && (
    <div className="glass-strong mention-list">
      {mentionResults.map((f, i) => (
        <button key={f} className="action" style={{ padding: '5px 8px', background: i === mention.sel ? 'var(--accent-soft)' : undefined }} onMouseDown={(e) => { e.preventDefault(); pickMention(f); }}>
          <FileCode2 size={13} color="var(--text-3)" />
          <span style={{ fontSize: 12.5 }}>{f.split('/').pop()}</span>
          <span style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</span>
        </button>
      ))}
    </div>
  );

  const limitBanner = outOfUsage && (
    <div className="limit-banner glass-soft">
      <CircleAlert size={15} />
      <div style={{ flex: 1 }}>
        <div className="t">You're out of usage for today</div>
        <div className="d">Chat is back at {new Date(usage.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.{usage.plan !== 'max' && ' KSTRL MAX gives you 20× the daily usage.'}</div>
      </div>
      <button className="btn light" onClick={() => props.onUsage?.()}>{usage.plan !== 'max' ? 'Upgrade' : 'View usage'}</button>
    </div>
  );

  const composer = (
    <div className={'composer glass-strong' + (hero ? ' hero' : '')} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      const p = e.dataTransfer.getData('text/kstrl-path');
      if (p) { e.preventDefault(); addContext({ kind: 'file', path: p }); return; }
      const imgs = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); addImages(imgs); }
    }}>
      {context.length > 0 && (
        <div className="ctx-pills" style={{ marginTop: 0 }}>
          {context.map((c, i) => (
            <span className={'pill' + (c.kind === 'image' ? ' img' : '')} key={i} title={c.kind === 'image' ? c.name : c.path}>
              {c.kind === 'image' ? <img src={c.thumb} alt="" /> : <FileCode2 size={11} />}
              <span>{c.kind === 'image' ? c.name : c.path.split('/').pop()}{c.kind === 'selection' ? `:${c.startLine}-${c.endLine}` : ''}</span>
              <button onClick={() => setContext((cs) => cs.filter((_, j) => j !== i))}><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={hero ? 2 : 1}
        value={input}
        placeholder={outOfUsage ? 'Out of usage for today' : hero ? 'Plan, Build, / for modes, @ for context' : { build: 'Ask Kestrel to build, fix or change anything… (@ for context)', plan: 'Brainstorm and plan with Kestrel… (@ for context)', ask: 'Ask about your code… (@ for context)' }[mode]}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="row">
        <button className="plus-btn" title="Add context" onClick={openAt('add')}><Plus size={17} /></button>
        <button className="chip-btn on" title="Switch mode (Ctrl+.)" onClick={openAt('mode')}>
          <modeDef.I size={13} />
          {modeDef.name} <ChevronDown size={11} />
        </button>
        <span className="spacer" />
        <button className="model-btn" title={mode === 'plan' ? 'Plan mode uses Colossus 2.1' : 'Model and effort'} onClick={openAt('model')}>
          <span className="mn">{parts.name}</span>{parts.effort && <span className="me">{parts.effort}</span>}
        </button>
        {chat.running ? (
          <button className="send grad stop" title="Stop (Esc)" onClick={() => store.stop(chat.id)}><Square size={11} fill="currentColor" /></button>
        ) : (
          <button className="send grad" title="Send (Enter)" disabled={!input.trim() || outOfUsage} onClick={() => send()}><ArrowUp size={16} strokeWidth={2.6} /></button>
        )}
      </div>
    </div>
  );

  const popovers = (
    <>
      {pop?.kind === 'model' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={320} below={hero} align="right">
          <ModelMenu info={info} settings={settings} onSettings={onSettings} onClose={() => setPop(null)} onManage={() => props.onManageModels?.()} />
        </Popover>
      )}
      {pop?.kind === 'effort' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={260} below={hero}>
          <div className="head label">Effort</div>
          {efforts.map((e) => {
            const I = EFFORT_ICON[e.id] || Gauge;
            return (
              <button key={e.id} className={'opt' + (e.id === effort?.id ? ' sel' : '')} onClick={() => { onSettings({ effort: e.id }); setPop(null); }}>
                <I size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
                <div style={{ flex: 1 }}><div className="n">{e.name}</div><div className="d">{e.description}</div></div>
                {e.id === effort?.id && <Check size={14} className="check" />}
              </button>
            );
          })}
        </Popover>
      )}
      {pop?.kind === 'mode' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={280} below={hero}>
          {MODES.map((m) => (
            <button key={m.id} className={'opt' + (m.id === mode ? ' sel' : '')} onClick={() => { onSettings({ mode: m.id }); setPop(null); }}>
              <m.I size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
              <div style={{ flex: 1 }}><div className="n">{m.name}</div><div className="d">{m.d}</div></div>
              {m.id === mode && <Check size={14} className="check" />}
            </button>
          ))}
        </Popover>
      )}
      {pop?.kind === 'add' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={260} below={hero}>
          <button className="opt" disabled={!workspace} style={!workspace ? { opacity: 0.45 } : null} onClick={() => { setPop(null); setInput((v) => v + (v && !v.endsWith(' ') ? ' @' : '@')); setMention({ query: '', sel: 0 }); focus(); }}>
            <AtSign size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}><div className="n">Files</div><div className="d">{workspace ? 'Attach files from this project' : 'Open a project first'}</div></div>
          </button>
          <label className="opt" style={{ cursor: 'pointer' }}>
            <ImageIcon size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}><div className="n">Image</div><div className="d">Attach a screenshot or design (or paste one with Ctrl+V)</div></div>
            <input type="file" accept="image/*" multiple hidden onChange={(e) => { setPop(null); addImages([...e.target.files]); e.target.value = ''; }} />
          </label>
          <button className="opt" disabled={!activePath} style={!activePath ? { opacity: 0.45 } : null} onClick={() => { setPop(null); addContext({ kind: 'file', path: activePath }); }}>
            <FileCode2 size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}><div className="n">Current file</div><div className="d">{activePath || 'No file open'}</div></div>
          </button>
        </Popover>
      )}
      {pop?.kind === 'project' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={300} below>
          <div className="head label">Project</div>
          <button className="opt" onClick={() => { setPop(null); props.onNewProject(); }}>
            <FolderPlus size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}><div className="n">Start from scratch</div><div className="d">Pick or create an empty folder for a new project</div></div>
          </button>
          <button className="opt" onClick={() => { setPop(null); props.onOpenFolder(); }}>
            <FolderOpen size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}><div className="n">Open folder…</div><div className="d">Work on an existing project</div></div>
          </button>
          {(settings.recentFolders || []).length > 0 && <div className="head label" style={{ paddingTop: 10 }}>Recent</div>}
          {(settings.recentFolders || []).slice(0, 6).map((f) => (
            <button key={f} className={'opt' + (workspace?.root === f ? ' sel' : '')} onClick={() => { setPop(null); props.onOpenRecent(f); }}>
              <Folder size={14} style={{ marginTop: 2, color: 'var(--text-3)' }} />
              <div style={{ flex: 1, minWidth: 0 }}><div className="n">{f.split(/[\\/]/).pop()}</div><div className="d" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</div></div>
              {workspace?.root === f && <Check size={14} className="check" />}
            </button>
          ))}
        </Popover>
      )}
      {pop?.kind === 'env' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={290} below>
          <div className="head label">Environment</div>
          <button className="opt sel" onClick={() => setPop(null)}>
            <Monitor size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
            <div style={{ flex: 1 }}><div className="n">This PC</div><div className="d">Kestrel edits files and runs commands locally{info?.platform === 'win32' ? ' in PowerShell' : ''}, inside the open project only.</div></div>
            <Check size={14} className="check" />
          </button>
        </Popover>
      )}
    </>
  );

  // ---------- Home hero (new chat) ----------
  if (hero) {
    return (
      <div className="home-center">
        <div className="hero-wrap">
          <div className="hero-chips">
            <button className="chip-btn" onClick={openAt('project')}>
              {workspace ? <Folder size={13} /> : <FolderPlus size={13} />}
              {workspace ? workspace.name : 'Start from scratch'} <ChevronDown size={11} />
            </button>
            <button className="chip-btn" onClick={openAt('env')}><Monitor size={13} /> This PC <ChevronDown size={11} /></button>
          </div>
          {mentionList}
          {limitBanner}
          {composer}
          <div className="suggest-list">
            {SUGGESTIONS.map((x) => (
              <button key={x.t} className="suggest-row" onClick={() => {
                if (x.mode !== mode) onSettings({ mode: x.mode });
                if (x.send) send(x.prompt, x.mode); else { setInput(x.prompt); setTimeout(() => { const ta = taRef.current; ta?.focus(); ta?.setSelectionRange(x.prompt.length, x.prompt.length); }, 0); }
              }}>
                <span className="suggest-ic glass-soft"><x.I size={14} /></span>
                <span className="t">{x.t}</span>
                <span className="d">{x.d}</span>
              </button>
            ))}
          </div>
        </div>
        {settings.showTips !== false && <Tip />}
        <div className="home-foot">{settings.configured ? `Kestrel · ${label} · ${settings.provider === 'anthropic' ? 'Anthropic API' : 'KSTRL API'}` : <button className="link" onClick={() => props.onConnect?.()}>Log in to start chatting →</button>}</div>
        {popovers}
      </div>
    );
  }

  // ---------- conversation ----------
  const messages = (
    <div className="messages" ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
      <div className={isHome ? 'thread' : ''}>
        {chat.items.length === 0 && (
          <div className="empty-chat">
            <img src="./logo.png" alt="" />
            <h2>Kestrel</h2>
            <p>{{ build: 'Build mode — Kestrel can read, edit and run code in your project.', plan: 'Plan mode — brainstorm and plan with Kestrel before anything is built.', ask: 'Ask mode — Kestrel reads your project and answers, without changing it.' }[mode]}</p>
            <div className="suggestions">
              {SUGGESTIONS.map((x) => <button key={x.t} className="glass-soft" onClick={() => { if (x.mode !== mode) onSettings({ mode: x.mode }); if (x.send) send(x.prompt, x.mode); else { setInput(x.prompt); setTimeout(focus, 0); } }}>{x.t}</button>)}
            </div>
          </div>
        )}
        {chat.items.map((it, i) => it.type === 'user' ? (
          <div className="msg" key={i}>
            <div className="msg-role user">You</div>
            <div className="user-bubble glass-soft">{it.text}</div>
            {it.context?.length > 0 && <div className="ctx-pills">{it.context.map((c, j) => (c.kind === 'image'
              ? <img key={j} className="msg-img" src={c.thumb} alt={c.name} title={c.name} />
              : <span className="pill" key={j}><FileCode2 size={11} /><span>{c.path.split('/').pop()}{c.kind === 'selection' ? `:${c.startLine}-${c.endLine}` : ''}</span></span>))}</div>}
          </div>
        ) : (
          <div className="msg" key={i}>
            <div className="msg-role kestrel">
              <img src="./logo.png" alt="" /> Kestrel <span className="sub">· {it.model}{it.mode === 'plan' ? ' · plan' : it.mode === 'ask' ? ' · ask' : ''}</span>
            </div>
            {it.blocks.map((b, j) => {
              if (b.kind === 'thinking') {
                const live = it.running && j === it.blocks.length - 1;
                return (
                  <details className="thinking" key={j} open={live}>
                    <summary>{live ? <ThinkingDots /> : <><Brain size={12} /> Thought process</>}</summary>
                    <div className="body-t">{b.text}</div>
                  </details>
                );
              }
              if (b.kind === 'text') return <Markdown key={j} text={b.text} />;
              if (b.kind === 'tool') return <ToolCard key={b.toolId} block={b} onApprove={(blk, ok) => store.approve(chat.id, blk, ok)} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
              if (b.kind === 'notice') return <div key={j} className="notice">{b.text}</div>;
              if (b.kind === 'error') return (
                <div key={j} className="error-box"><CircleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} /><div>{b.text}{/Log in|Connect API/.test(b.text) ? <> <button className="btn" style={{ height: 22, marginLeft: 6 }} onClick={() => props.onConnect?.()}>Log in</button></> : /Settings/.test(b.text) && <> <button className="btn" style={{ height: 22, marginLeft: 6 }} onClick={onOpenSettings}>Open Settings</button></>}</div></div>
              );
              return null;
            })}
            {it.running && (() => {
              const last = it.blocks[it.blocks.length - 1];
              const streaming = last && (last.kind === 'thinking' || last.kind === 'text' || (last.kind === 'tool' && ['pending', 'running', 'approval'].includes(last.status)));
              return streaming ? null : <ThinkingDots label={it.blocks.length ? '' : 'Thinking'} />;
            })()}
            {!it.running && <ChangesCard item={it} onOpenDiff={onOpenDiff} onRevert={() => revert(it)} />}
            {!it.running && it.mode === 'plan' && i === chat.items.length - 1 && it.blocks.some((b) => b.kind === 'text') && (
              <button className="btn light build-plan" disabled={outOfUsage} onClick={() => { onSettings({ mode: 'build' }); send('Build the plan above.', 'build'); }}><Hammer size={13} /> Build this plan</button>
            )}
            {!it.running && it.blocks.some((b) => b.kind === 'text') && (
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                <button className="icon-btn" title="Copy reply" onClick={() => navigator.clipboard.writeText(it.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n\n'))}><Copy size={12} /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className={isHome ? 'home-chat' : 'agent'} style={isHome ? null : { width: '100%', height: '100%', borderLeft: 0 }}>
      {!isHome && (
        <div className="agent-head">
          <img src="./logo.png" alt="" style={{ width: 16, height: 16 }} />
          <span className="label title" style={{ color: 'var(--text)' }}>{chat.items.length ? chat.title : 'Kestrel'}</span>
          <button className="icon-btn" title="New Chat" onClick={() => store.newChat(workspace?.root ?? null)}><Plus size={15} /></button>
          <button className="icon-btn" title="Chat History" onClick={() => setShowHistory((v) => !v)} style={showHistory ? { color: 'var(--accent)' } : null}><History size={14} /></button>
          <button className="icon-btn" title="Close Panel (Ctrl+Alt+B)" onClick={onClosePanel}><PanelRightClose size={15} /></button>
        </div>
      )}
      {showHistory && !isHome ? (
        <div className="messages">
          <div className="label" style={{ marginBottom: 10 }}>Chats</div>
          {s.chats.map((c) => (
            <div key={c.id} className="changes-row" style={{ borderTop: 0, borderRadius: 8 }} onClick={() => { store.setActive(c.id); setShowHistory(false); }}>
              {c.running ? <Loader2 size={13} className="spin" color="var(--accent)" /> : <MessageCircleQuestion size={13} color="var(--text-3)" />}
              <span className="p" style={{ fontFamily: 'var(--sans)', fontSize: 12.5, color: c.id === chat.id ? 'var(--text)' : 'var(--text-2)' }}>{c.items.length ? c.title : 'New chat'}</span>
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); store.close(c.id); }}><X size={12} /></button>
            </div>
          ))}
        </div>
      ) : messages}
      <div className={'composer-wrap' + (isHome ? ' thread' : '')}>
        {mentionList}
        {limitBanner}
        {composer}
        <div className="composer-foot">Kestrel can make mistakes. Review changes before shipping.</div>
      </div>
      {popovers}
    </div>
  );
});

export default ChatView;
