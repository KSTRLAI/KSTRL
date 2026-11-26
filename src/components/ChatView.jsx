import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Square, Plus, X, ChevronDown, Check, Brain, FileCode2, Terminal as TermIcon, Search, FolderTree, FilePen,
  FilePlus2, Loader2, CircleAlert, CircleCheck, CircleX, Infinity as InfinityIcon, MessageCircleQuestion, AtSign, Zap,
  Gauge, Flame, Rocket, RotateCcw, Eye, History, PanelRightClose, Copy, Monitor, FolderPlus, FolderOpen, Folder,
  Hammer, ListChecks, Bug, Compass, Lock,
} from 'lucide-react';
import { renderMarkdown } from '../lib/markdown.js';
import { useChats, chats as store, activeChat } from '../lib/chatStore.js';

const api = window.kstrl;
const EFFORT_ICON = { flash: Zap, normal: Gauge, high: Flame, max: Rocket };
const TOOL_ICON = { list_files: FolderTree, read_file: FileCode2, search: Search, write_file: FilePlus2, edit_file: FilePen, run_command: TermIcon };
const TOOL_VERB = { list_files: 'List', read_file: 'Read', search: 'Search', write_file: 'Write', edit_file: 'Edit', run_command: 'Run' };

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
  if (name === 'search') return input.query;
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
          <div className="label" style={{ color: 'var(--accent)' }}>Run this command?</div>
          <code>{block.input?.command}</code>
          <div className="row">
            <button className="btn grad" onClick={() => onApprove(block, true)}>Run</button>
            <button className="btn" onClick={() => onApprove(block, false)}>Skip</button>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: 'var(--text-3)', alignSelf: 'center' }}>Auto-run can be enabled in Settings</span>
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

export function Popover({ anchor, onClose, children, width = 300, below = false }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight || 200;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    const top = below || r.top - h - 6 < 8 ? Math.min(r.bottom + 6, window.innerHeight - h - 8) : r.top - h - 6;
    setPos({ left, top });
  }, [anchor, width, below]);
  useEffect(() => {
    const close = (e) => { if (!ref.current?.contains(e.target) && !anchor?.contains(e.target)) onClose(); };
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [anchor, onClose]);
  return <div ref={ref} className="popover glass-strong" style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>{children}</div>;
}

const SUGGESTIONS = [
  { I: Hammer, t: 'Build a prototype', d: 'Describe an app and Kestrel scaffolds it', prompt: 'Build a prototype of ', mode: 'agent' },
  { I: ListChecks, t: 'Start with a plan', d: 'Align on implementation before writing code', prompt: 'Before writing any code, propose a step-by-step implementation plan for: ', mode: 'ask' },
  { I: Bug, t: 'Debug an issue', d: 'Find root causes and fix tricky bugs', prompt: 'Help me debug this issue: ', mode: 'agent' },
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
  const model = models.find((m) => m.id === settings.model) || models[models.length - 1];
  const effort = efforts.find((e) => e.id === settings.effort) || efforts[1];
  const mode = settings.mode || 'agent';
  const EffortIcon = EFFORT_ICON[effort?.id] || Gauge;
  const isHome = variant === 'home';
  const hero = isHome && chat.items.length === 0;

  useLayoutEffect(() => { const el = scrollRef.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [chat]);
  useLayoutEffect(() => { const ta = taRef.current; if (!ta) return; ta.style.height = 'auto'; ta.style.height = Math.min(hero ? 260 : 220, ta.scrollHeight) + 'px'; }, [input, hero]);
  useEffect(() => { setContext([]); stick.current = true; }, [chat.id]);

  const addContext = useCallback((c) => {
    setContext((cs) => (cs.some((x) => x.kind === c.kind && x.path === c.path && x.startLine === c.startLine) ? cs : [...cs, c]));
    setTimeout(() => taRef.current?.focus(), 0);
  }, []);

  const focus = () => taRef.current?.focus();
  useImperativeHandle(ref, () => ({ focus, addContext, setInput: (t) => { setInput(t); setTimeout(focus, 0); } }));

  const send = async (override) => {
    const text = (override ?? input).trim();
    if (!text || chat.running) return;
    const ctx = context;
    setInput('');
    setContext([]);
    setMention(null);
    stick.current = true;
    if (!settings.onboarded) onSettings({ onboarded: true });
    store.send({ text, context: ctx, model, effort, mode, activePath, project: workspace?.root ?? null });
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
    if (e.key === '.' && e.ctrlKey) { e.preventDefault(); onSettings({ mode: mode === 'agent' ? 'ask' : 'agent' }); }
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

  const composer = (
    <div className={'composer glass-strong' + (hero ? ' hero' : '')} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const p = e.dataTransfer.getData('text/kstrl-path'); if (p) { e.preventDefault(); addContext({ kind: 'file', path: p }); } }}>
      {context.length > 0 && (
        <div className="ctx-pills" style={{ marginTop: 0 }}>
          {context.map((c, i) => (
            <span className="pill" key={i} title={c.path}>
              <FileCode2 size={11} />
              <span>{c.path.split('/').pop()}{c.kind === 'selection' ? `:${c.startLine}-${c.endLine}` : ''}</span>
              <button onClick={() => setContext((cs) => cs.filter((_, j) => j !== i))}><X size={10} /></button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        rows={hero ? 2 : 1}
        value={input}
        placeholder={hero ? 'Plan, Build, / for modes, @ for context' : mode === 'agent' ? 'Ask Kestrel to build, fix or change anything… (@ for context)' : 'Ask about your code… (@ for context)'}
        onChange={onInput}
        onKeyDown={onKeyDown}
      />
      <div className="row">
        <button className="round-btn glass-soft" title="Add context" onClick={openAt('add')}><Plus size={15} /></button>
        <button className="chip-btn on" title="Switch mode (Ctrl+.)" onClick={openAt('mode')}>
          {mode === 'agent' ? <InfinityIcon size={13} color="var(--accent)" /> : <MessageCircleQuestion size={13} />}
          {mode === 'agent' ? 'Agent' : 'Ask'} <ChevronDown size={11} />
        </button>
        <button className="chip-btn" title="Effort" onClick={openAt('effort')}><EffortIcon size={12} /> {effort?.name} <ChevronDown size={11} /></button>
        <span className="spacer" />
        <button className="chip-btn" title="Model" onClick={openAt('model')}>
          <span className="mname">{model?.name || 'Model'}</span>
          {model?.tag === 'Flagship' && <Lock size={10} style={{ opacity: 0.6 }} />}
          <ChevronDown size={11} />
        </button>
        {chat.running ? (
          <button className="send grad stop" title="Stop (Esc)" onClick={() => store.stop(chat.id)}><Square size={11} fill="currentColor" /></button>
        ) : (
          <button className="send grad" title="Send (Enter)" disabled={!input.trim()} onClick={() => send()}><ArrowUp size={16} strokeWidth={2.6} /></button>
        )}
      </div>
    </div>
  );

  const popovers = (
    <>
      {pop?.kind === 'model' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} width={310} below={hero}>
          <div className="head label">Model</div>
          {models.map((m) => (
            <button key={m.id} className={'opt' + (m.id === model?.id ? ' sel' : '')} onClick={() => { onSettings({ model: m.id }); setPop(null); }}>
              <div style={{ flex: 1 }}>
                <div className="n">{m.name} <span className={'tg' + (m.tag === 'Flagship' ? ' flag' : '')}>{m.tag}</span></div>
                <div className="d">{m.description}</div>
              </div>
              {m.id === model?.id && <Check size={14} className="check" />}
            </button>
          ))}
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
          {[{ id: 'agent', name: 'Agent', I: InfinityIcon, d: 'Plans, edits files and runs commands to finish the task.' }, { id: 'ask', name: 'Ask', I: MessageCircleQuestion, d: 'Reads and explains your code. Never changes anything.' }].map((m) => (
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
          {composer}
          <div className="suggest-list">
            {SUGGESTIONS.map((x) => (
              <button key={x.t} className="suggest-row" onClick={() => {
                if (x.mode !== mode) onSettings({ mode: x.mode });
                if (x.send) send(x.prompt); else { setInput(x.prompt); setTimeout(() => { const ta = taRef.current; ta?.focus(); ta?.setSelectionRange(x.prompt.length, x.prompt.length); }, 0); }
              }}>
                <span className="suggest-ic glass-soft"><x.I size={14} /></span>
                <span className="t">{x.t}</span>
                <span className="d">{x.d}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="home-foot">{settings.configured ? `Kestrel · ${model?.name} · ${settings.provider === 'anthropic' ? 'Anthropic API' : 'Unsloth server'}` : <button className="link" onClick={onOpenSettings}>Connect your Unsloth server to start chatting →</button>}</div>
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
            <p>{mode === 'agent' ? 'Agent mode — Kestrel can read, edit and run code in your project.' : 'Ask mode — Kestrel reads your project and answers, without changing it.'}</p>
            <div className="suggestions">
              {SUGGESTIONS.map((x) => <button key={x.t} className="glass-soft" onClick={() => { if (x.mode !== mode) onSettings({ mode: x.mode }); if (x.send) send(x.prompt); else { setInput(x.prompt); setTimeout(focus, 0); } }}>{x.t}</button>)}
            </div>
          </div>
        )}
        {chat.items.map((it, i) => it.type === 'user' ? (
          <div className="msg" key={i}>
            <div className="msg-role user">You</div>
            <div className="user-bubble glass-soft">{it.text}</div>
            {it.context?.length > 0 && <div className="ctx-pills">{it.context.map((c, j) => <span className="pill" key={j}><FileCode2 size={11} /><span>{c.path.split('/').pop()}{c.kind === 'selection' ? `:${c.startLine}-${c.endLine}` : ''}</span></span>)}</div>}
          </div>
        ) : (
          <div className="msg" key={i}>
            <div className="msg-role kestrel">
              <img src="./logo.png" alt="" /> Kestrel <span style={{ color: 'var(--text-3)', letterSpacing: '.08em' }}>· {it.model}{it.mode === 'ask' ? ' · ask' : ''}</span>
              {it.running && <span className="pulse" />}
            </div>
            {it.blocks.length === 0 && it.running && <div className="notice">Thinking…</div>}
            {it.blocks.map((b, j) => {
              if (b.kind === 'thinking') {
                const live = it.running && j === it.blocks.length - 1;
                return (
                  <details className="thinking" key={j} open={live}>
                    <summary><Brain size={12} /> {live ? 'Thinking' : 'Thought process'} {live && <span className="pulse" />}</summary>
                    <div className="body-t">{b.text}</div>
                  </details>
                );
              }
              if (b.kind === 'text') return <Markdown key={j} text={b.text} />;
              if (b.kind === 'tool') return <ToolCard key={b.toolId} block={b} onApprove={(blk, ok) => store.approve(chat.id, blk, ok)} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />;
              if (b.kind === 'notice') return <div key={j} className="notice">{b.text}</div>;
              if (b.kind === 'error') return (
                <div key={j} className="error-box"><CircleAlert size={15} style={{ flexShrink: 0, marginTop: 1 }} /><div>{b.text}{/Settings/.test(b.text) && <> <button className="btn" style={{ height: 22, marginLeft: 6 }} onClick={onOpenSettings}>Open Settings</button></>}</div></div>
              );
              return null;
            })}
            {!it.running && <ChangesCard item={it} onOpenDiff={onOpenDiff} onRevert={() => revert(it)} />}
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
        {composer}
        <div className="composer-foot">Kestrel can make mistakes. Review changes before shipping.</div>
      </div>
      {popovers}
    </div>
  );
});

export default ChatView;
