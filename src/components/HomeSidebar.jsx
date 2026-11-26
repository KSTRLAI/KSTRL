import React, { useMemo, useState } from 'react';
import { SquarePen, Search, SlidersHorizontal, Bot, ArrowUpCircle, Folder, FolderOpen, FolderPlus, ListFilter, MessageSquare, Loader2, X, Settings as SettingsIcon, Server, Check, ChevronRight, ChevronDown } from 'lucide-react';
import { useChats, chats as store, activeChat } from '../lib/chatStore.js';

const base = (p) => (p ? p.split(/[\\/]/).pop() : '');

function Ring({ value, total }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(255,255,255,.12)" strokeWidth="2" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="url(#ringg)" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value / total)} />
      <defs><linearGradient id="ringg" x1="0" x2="1"><stop offset="0" stopColor="#86efac" /><stop offset="1" stopColor="#4ade80" /></linearGradient></defs>
    </svg>
  );
}

export default function HomeSidebar({ settings, workspace, width, onNewChat, onOpenFolder, onNewProject, onOpenRecent, onCustomize, onSettings, onServer, onSearch, homePage, onAutomations, onChats, update, onUpdate }) {
  const s = useChats();
  const current = activeChat(s);
  const [filter, setFilter] = useState(null);
  const [collapsed, setCollapsed] = useState({});

  const projects = useMemo(() => {
    const roots = [...(settings.recentFolders || [])];
    if (workspace && !roots.includes(workspace.root)) roots.unshift(workspace.root);
    for (const c of s.chats) if (c.project && !roots.includes(c.project)) roots.push(c.project);
    const q = (filter || '').toLowerCase();
    return roots
      .map((root) => ({ root, chats: s.chats.filter((c) => c.project === root && (c.items.length || c.running)) }))
      .filter((p) => !q || base(p.root).toLowerCase().includes(q) || p.chats.some((c) => c.title.toLowerCase().includes(q)));
  }, [settings.recentFolders, workspace, s.chats, filter]);

  const loose = s.chats.filter((c) => !c.project && (c.items.length || c.running) && (!filter || c.title.toLowerCase().includes(filter.toLowerCase())));

  const steps = [
    { done: !!settings.configured, label: 'Connect your model server', action: 'Connect Unsloth Server', run: onServer, Icon: Server },
    { done: !!workspace || (settings.recentFolders || []).length > 0, label: 'Open a project', action: 'Open a Project', run: onOpenFolder, Icon: FolderOpen },
    { done: !!settings.onboarded, label: 'Send your first message', action: 'Ask Kestrel', run: onNewChat, Icon: SquarePen },
  ];
  const doneCount = steps.filter((x) => x.done).length;
  const next = steps.find((x) => !x.done);

  const chatRow = (c, indent) => (
    <div key={c.id} className={'hs-chat' + (c.id === current.id ? ' active' : '')} style={{ paddingLeft: indent }} onClick={() => { store.setActive(c.id); onChats(); }} title={c.title}>
      {c.running ? <Loader2 size={12} className="spin" color="var(--accent)" /> : <MessageSquare size={12} />}
      <span className="name">{c.title}</span>
      <button className="x" onClick={(e) => { e.stopPropagation(); store.close(c.id); }}><X size={11} /></button>
    </div>
  );

  return (
    <aside className="home-side glass-pane" style={{ width }}>
      <nav className="hs-nav">
        <button className={'hs-item' + (homePage !== 'automations' && current.items.length === 0 ? ' active' : '')} onClick={onNewChat}><SquarePen size={16} /> New Chat <span className="kbd">Ctrl+N</span></button>
        <button className="hs-item" onClick={onSearch}><Search size={16} /> Search <span className="kbd">Ctrl+P</span></button>
        <button className={'hs-item' + (homePage === 'automations' ? ' active' : '')} onClick={onAutomations}><Bot size={16} /> Automations {(settings.automations || []).some((a) => a.enabled && a.schedule?.type !== 'manual') && <span className="hs-dot" title="Scheduled automations active" />}</button>
        <button className="hs-item" onClick={onCustomize}><SlidersHorizontal size={16} /> Customize</button>
      </nav>

      <div className="hs-section">
        <span>Projects</span>
        <div className="actions">
          <button className="icon-btn" title="Filter" style={filter !== null ? { color: 'var(--accent)' } : null} onClick={() => setFilter((f) => (f === null ? '' : null))}><ListFilter size={14} /></button>
          <button className="icon-btn" title="New project from scratch" onClick={onNewProject}><FolderPlus size={14} /></button>
        </div>
      </div>
      {filter !== null && <div style={{ padding: '0 10px 6px' }}><input className="input" autoFocus placeholder="Filter projects and chats" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter(null)} style={{ height: 28, fontSize: 12 }} /></div>}

      <div className="hs-list">
        {projects.length === 0 && loose.length === 0 && (
          <div className="hs-empty">
            No projects yet.
            <button className="btn glass-soft" style={{ marginTop: 10, width: '100%' }} onClick={onOpenFolder}><FolderOpen size={13} /> Open Folder</button>
          </div>
        )}
        {projects.map((p) => {
          const isOpen = workspace?.root === p.root;
          const coll = collapsed[p.root] ?? !isOpen;
          return (
            <div key={p.root}>
              <div className={'hs-project' + (isOpen ? ' open' : '')} title={p.root} onClick={() => (isOpen ? setCollapsed((c) => ({ ...c, [p.root]: !coll })) : onOpenRecent(p.root))}>
                <span className="chev" onClick={(e) => { e.stopPropagation(); setCollapsed((c) => ({ ...c, [p.root]: !coll })); }}>{p.chats.length ? (coll ? <ChevronRight size={12} /> : <ChevronDown size={12} />) : null}</span>
                {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                <span className="name">{base(p.root)}</span>
                {isOpen && <Check size={12} color="var(--accent)" />}
              </div>
              {!coll && p.chats.map((c) => chatRow(c, 34))}
            </div>
          );
        })}
        {loose.length > 0 && <div className="hs-sub">Chats</div>}
        {loose.map((c) => chatRow(c, 14))}
      </div>

      {next && (
        <div className="gs-card glass">
          <div className="gs-head"><span>Getting Started</span><span className="gs-count">{doneCount}/3 <Ring value={doneCount} total={3} /></span></div>
          <div className="gs-steps">
            {steps.map((x) => (
              <div key={x.label} className={'gs-step' + (x.done ? ' done' : '')}>{x.done ? <Check size={11} /> : <span className="dot" />}{x.label}</div>
            ))}
          </div>
          <button className="btn grad" style={{ width: '100%', height: 32 }} onClick={next.run}><next.Icon size={14} /> {next.action}</button>
        </div>
      )}

      <div className="hs-user">
        <span className="avatar">{(settings.userName || 'K')[0].toUpperCase()}</span>
        <span className="name">{settings.userName || 'You'}</span>
        {(update?.status === 'ready' || update?.status === 'available') && <button className="btn grad update-btn" title={`KSTRL ${update.version}`} onClick={onUpdate}><ArrowUpCircle size={13} /> Update</button>}
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={onSettings}><SettingsIcon size={15} /></button>
      </div>
    </aside>
  );
}
