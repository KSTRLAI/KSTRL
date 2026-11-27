import React, { useMemo, useState } from 'react';
import { fmtKbd, mod } from '../lib/keys.js';
import { SquarePen, Search, SlidersHorizontal, Bot, ArrowUpCircle, Folder, FolderOpen, FolderPlus, ListFilter, MessageSquare, Loader2, X, Settings as SettingsIcon, Server, Check, ChevronRight, ChevronDown, Square, Sparkles } from 'lucide-react';
import { useChats, chats as store, activeChat } from '../lib/chatStore.js';
import { Popover } from './ChatView.jsx';
import Avatar from './Avatar.jsx';
import { BookOpen, Keyboard, TriangleAlert, MessageCircle, LogOut, UserPlus, LogIn, RefreshCw, Power } from 'lucide-react';

const SITE = 'https://kstrlsi.base44.app/';
const ISSUES = 'https://github.com/KSTRLAI/KSTRL/issues/new';

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

export default function HomeSidebar({ settings, workspace, width, onNewChat, onOpenFolder, onNewProject, onOpenRecent, onCustomize, onSettings, onServer, onSearch, homePage, onAutomations, onChats, update, onUpdate, onShortcuts, onToast, onLogin, onSkills }) {
  const [acct, setAcct] = useState(null);
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
    { done: !!settings.configured, label: 'Log in to KSTRL', action: 'Log in', run: onServer, Icon: LogIn },
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
        <button className={'hs-item' + (homePage === 'chat' && current.items.length === 0 ? ' active' : '')} onClick={onNewChat}><SquarePen size={16} /> New Chat <span className="kbd">{fmtKbd('Ctrl+N')}</span></button>
        <button className="hs-item" onClick={onSearch}><Search size={16} /> Search <span className="kbd">{fmtKbd('Ctrl+P')}</span></button>
        <button className={'hs-item' + (homePage === 'automations' ? ' active' : '')} onClick={onAutomations}><Bot size={16} /> Automations {(settings.automations || []).some((a) => a.enabled && a.schedule?.type !== 'manual') && <span className="hs-dot" title="Scheduled automations active" />}</button>
        <button className={'hs-item' + (homePage === 'skills' ? ' active' : '')} onClick={onSkills}><Sparkles size={16} /> Skills</button>
        <button className="hs-item" onClick={onCustomize}><SlidersHorizontal size={16} /> Customize</button>
      </nav>

      {s.chats.some((c) => c.running) && (
        <>
          <div className="hs-section"><span>Running agents</span><span className="hs-count">{s.chats.filter((c) => c.running).length}</span></div>
          <div className="hs-running">
            {s.chats.filter((c) => c.running).map((c) => (
              <div key={c.id} className={'hs-chat' + (c.id === current.id ? ' active' : '')} style={{ paddingLeft: 14 }} onClick={() => { store.setActive(c.id); onChats(); }} title={c.title}>
                <Loader2 size={12} className="spin" />
                <span className="name">{c.title}</span>
                <span className="proj">{base(c.project)}</span>
                <button className="x stop" title="Stop" onClick={(e) => { e.stopPropagation(); store.stop(c.id); }}><Square size={9} fill="currentColor" /></button>
              </div>
            ))}
          </div>
        </>
      )}

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
        <button className="hs-acct" title="Account" onClick={(e) => setAcct(acct ? null : e.currentTarget)}>
          <Avatar size={28} />
          <span className="name">{settings.loggedIn && settings.account?.email ? settings.account.email : 'Not logged in'}</span>
        </button>
        {(update?.status === 'ready' || update?.status === 'available') && <button className="btn grad update-btn" title={`KSTRL ${update.version}`} onClick={onUpdate}><ArrowUpCircle size={13} /> Update</button>}
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={onSettings}><SettingsIcon size={15} /></button>
      </div>
      {acct && (
        <Popover anchor={acct} onClose={() => setAcct(null)} width={250}>
          <div className="acct-menu">
            {settings.loggedIn && (
              <div className="acct-head">
                <Avatar size={30} />
                <div style={{ minWidth: 0 }}><div className="nm">{settings.account?.email || settings.account?.name || 'Your account'}</div>{settings.account?.name && settings.account?.email && <div className="em">{settings.account.name}</div>}</div>
                <span className={'pl' + (settings.usageToday?.plan === 'max' ? ' max' : '')}>{settings.usageToday?.plan === 'max' ? 'MAX' : 'Free'}</span>
              </div>
            )}
            {settings.loggedIn && <div className="acct-sep" />}
            {[
              [SettingsIcon, 'Settings', 'Ctrl+,', onSettings],
              '-',
              [RefreshCw, 'Check for Updates', '', async () => { const u = await window.kstrl.update.check(); onToast?.(u?.status === 'unsupported' ? (u.reason === 'platform' ? 'On Mac, download new versions from the KSTRL releases page' : 'Updates work in the installed app') : 'Checking for updates…'); }],
              [BookOpen, 'Docs', '', () => window.kstrl.shell.openExternal(SITE)],
              [Keyboard, 'Shortcuts', '', onShortcuts],
              [TriangleAlert, 'Report Issue', '', () => window.kstrl.shell.openExternal(ISSUES)],
              [MessageCircle, 'Contact Us', '', () => window.kstrl.shell.openExternal(SITE)],
              '-',
              ...(settings.loggedIn ? [[LogOut, 'Log Out', '', async () => { await window.kstrl.auth.logout(); onToast?.('Logged out'); }]] : [[LogIn, 'Log In', '', () => onLogin('login')], [UserPlus, 'Sign Up', '', () => onLogin('signup')]]),
              [Power, 'Quit KSTRL', '', () => window.close()],
            ].map((it, i) => it === '-' ? <div key={i} className="acct-sep" /> : (
              <button key={it[1]} className="acct-item" onClick={() => { setAcct(null); it[3](); }}>
                {React.createElement(it[0], { size: 16 })}
                <span>{it[1]}</span>
                {it[2] && <span className="kbd">{fmtKbd(it[2])}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </aside>
  );
}
