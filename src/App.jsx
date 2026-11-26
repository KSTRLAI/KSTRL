import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Files, Search, Bot, Settings as SettingsIcon, TerminalSquare, GitBranch, Sparkles, CircleCheck, CircleAlert, PanelLeft, ArrowLeft, ArrowRight, ArrowUpRight, Ellipsis, PanelRight } from 'lucide-react';
import TitleBar from './components/TitleBar.jsx';
import Explorer from './components/Explorer.jsx';
import SearchPanel from './components/SearchPanel.jsx';
import EditorArea, { ensureDoc, disposeDoc, docs, isDirty } from './components/EditorArea.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import ChatView, { Popover } from './components/ChatView.jsx';
import HomeSidebar from './components/HomeSidebar.jsx';
import Palette from './components/Palette.jsx';
import { SettingsModal, DiffModal, Welcome } from './components/Modals.jsx';
import { languageFor } from './lib/lang.js';
import { useChats, chats as store, activeChat } from './lib/chatStore.js';

const api = window.kstrl;
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function useDrag(onMove) {
  const [dragging, setDragging] = useState(false);
  const start = (e) => {
    e.preventDefault();
    setDragging(true);
    const move = (ev) => onMove(ev);
    const up = () => { setDragging(false); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return [dragging, start];
}

export default function App() {
  const [info, setInfo] = useState(null);
  const [settings, setSettings] = useState({ model: 'colossus-3', effort: 'normal', mode: 'agent', fontSize: 14, recentFolders: [], provider: 'unsloth' });
  const [workspace, setWorkspace] = useState(null);
  const [files, setFiles] = useState([]);
  const [mainView, setMainView] = useState('home'); // home | ide
  const [homeSide, setHomeSide] = useState(true);
  const [view, setView] = useState('explorer'); // IDE sidebar: explorer | search | null
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(true);
  const [palette, setPalette] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(null);
  const [diff, setDiff] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [moreMenu, setMoreMenu] = useState(null);
  const [sideW, setSideW] = useState(260);
  const [homeW, setHomeW] = useState(290);
  const [agentW, setAgentW] = useState(440);
  const [panelH, setPanelH] = useState(260);
  const [searchFocus, setSearchFocus] = useState(0);
  const editorRef = useRef(null);
  const agentRef = useRef(null);
  const homeChatRef = useRef(null);
  const chatState = useChats();

  const toast = useCallback((text) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);

  const refreshFiles = useCallback(async () => {
    try { setFiles(await api.fs.walk()); } catch { setFiles([]); }
  }, []);

  useEffect(() => {
    (async () => {
      setInfo(await api.info());
      const s = await api.settings.get();
      setSettings(s);
      const ws = await api.workspace.current();
      if (ws) { setWorkspace(ws); store.setProject(ws.root); }
    })();
  }, []);

  useEffect(() => { if (workspace) refreshFiles(); else setFiles([]); }, [workspace, refreshFiles]);
  useEffect(() => {
    let t;
    const off = api.fs.onTree(() => { clearTimeout(t); t = setTimeout(refreshFiles, 800); });
    return () => { off(); clearTimeout(t); };
  }, [refreshFiles]);

  const updateSettings = useCallback(async (patch) => {
    const { apiKey, unslothKey, ...visible } = patch;
    setSettings((s) => ({ ...s, ...visible }));
    const next = await api.settings.update(patch);
    setSettings(next);
    return next;
  }, []);

  // ---------- files & tabs ----------
  const openFile = useCallback(async (path, line) => {
    if (!docs.has(path)) {
      try { ensureDoc(path, await api.fs.readFile(path)); }
      catch (e) { toast(`Can't open ${path}: ${cleanErr(e)}`); return; }
    }
    setTabs((ts) => (ts.some((t) => t.path === path) ? ts : [...ts, { path, dirty: false }]));
    setActive(path);
    setMainView('ide');
    if (line) setTimeout(() => editorRef.current?.revealLine(line), 60);
  }, [toast]);

  const saveFile = useCallback(async (path) => {
    const d = docs.get(path);
    if (!d) return;
    try {
      await api.fs.writeFile(path, d.model.getValue());
      d.savedVersion = d.model.getAlternativeVersionId();
      setTabs((ts) => ts.map((t) => (t.path === path ? { ...t, dirty: false } : t)));
    } catch (e) { toast(`Save failed: ${cleanErr(e)}`); }
  }, [toast]);

  const closeTab = useCallback((path) => {
    if (isDirty(path) && !confirm(`${path.split('/').pop()} has unsaved changes. Close without saving?`)) return;
    setTabs((ts) => {
      const i = ts.findIndex((t) => t.path === path);
      const n = ts.filter((t) => t.path !== path);
      setActive((a) => (a === path ? (n[i] || n[i - 1] || null)?.path ?? null : a));
      return n;
    });
    setTimeout(() => disposeDoc(path), 0);
  }, []);

  const setDirty = useCallback((path, dirty) => setTabs((ts) => (ts.some((t) => t.path === path && t.dirty !== dirty) ? ts.map((t) => (t.path === path ? { ...t, dirty } : t)) : ts)), []);

  useEffect(() => api.fs.onChanged(async ({ path }) => {
    const d = docs.get(path);
    if (!d) return;
    if (isDirty(path)) { toast(`${path} changed on disk — you have unsaved edits`); return; }
    try {
      const content = await api.fs.readFile(path);
      if (content !== d.model.getValue()) {
        d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: content }], () => null);
        d.savedVersion = d.model.getAlternativeVersionId();
        setDirty(path, false);
      }
    } catch {}
  }), [toast, setDirty]);

  // ---------- workspace ----------
  const resetEditors = () => { for (const p of [...docs.keys()]) disposeDoc(p); setTabs([]); setActive(null); };
  const adopt = async (ws) => { resetEditors(); setWorkspace(ws); store.setProject(ws.root); setSettings(await api.settings.get()); };
  const pickFolder = useCallback(async (opts) => {
    try { const ws = await api.workspace.pick(opts); if (ws) await adopt(ws); return ws; }
    catch (e) { toast(cleanErr(e)); return null; }
  }, [toast]);
  const newProject = useCallback(async () => {
    const ws = await pickFolder({ title: 'Choose or create an empty folder for your new project', button: 'Use This Folder' });
    if (ws) { store.newChat(ws.root); setMainView('home'); setTimeout(() => homeChatRef.current?.focus(), 50); }
  }, [pickFolder]);
  const openRecent = useCallback(async (dir) => {
    try { await adopt(await api.workspace.open(dir)); } catch (e) { toast(cleanErr(e)); }
  }, [toast]);
  const closeFolder = useCallback(async () => { await api.workspace.close(); resetEditors(); setWorkspace(null); }, []);

  const newUntitled = useCallback(async () => {
    if (!workspace) { pickFolder(); return; }
    const name = prompt('New file name (relative to the project root):', 'untitled.txt');
    if (!name) return;
    try { await api.fs.create(name.replace(/\\/g, '/'), false); openFile(name.replace(/\\/g, '/')); }
    catch (e) { toast(cleanErr(e)); }
  }, [workspace, pickFolder, openFile, toast]);

  // ---------- chat helpers ----------
  const focusChat = useCallback(() => setTimeout(() => (mainView === 'home' ? homeChatRef : agentRef).current?.focus(), 40), [mainView]);
  const newChat = useCallback(() => { store.newChat(workspace?.root ?? null); if (mainView === 'ide') setAgentOpen(true); focusChat(); }, [workspace, mainView, focusChat]);
  const showAgent = useCallback(() => { if (mainView === 'ide') setAgentOpen(true); focusChat(); }, [mainView, focusChat]);
  const addSelectionToChat = useCallback(() => {
    const sel = editorRef.current?.getSelection();
    setAgentOpen(true);
    setTimeout(() => {
      if (sel) agentRef.current?.addContext({ kind: 'selection', ...sel });
      else if (active) agentRef.current?.addContext({ kind: 'file', path: active });
      agentRef.current?.focus();
    }, 40);
  }, [active]);

  // ---------- commands ----------
  const commands = useMemo(() => [
    { id: 'newchat', label: 'Kestrel: New Chat', kbd: 'Ctrl+N', run: newChat },
    { id: 'home', label: 'View: Agents Home', kbd: 'Ctrl+Shift+H', run: () => setMainView('home') },
    { id: 'ide', label: 'View: Open IDE', kbd: 'Ctrl+E', run: () => setMainView('ide') },
    { id: 'newproject', label: 'File: New Project from Scratch…', run: newProject },
    { id: 'open', label: 'File: Open Folder…', kbd: 'Ctrl+O', run: () => pickFolder() },
    { id: 'new', label: 'File: New File…', kbd: 'Ctrl+Alt+N', run: newUntitled },
    { id: 'save', label: 'File: Save', kbd: 'Ctrl+S', run: () => active && saveFile(active) },
    { id: 'saveall', label: 'File: Save All', kbd: 'Ctrl+Shift+S', run: () => tabs.filter((t) => t.dirty).forEach((t) => saveFile(t.path)) },
    { id: 'closetab', label: 'View: Close Editor', kbd: 'Ctrl+W', run: () => active && closeTab(active) },
    { id: 'closefolder', label: 'File: Close Folder', run: closeFolder },
    { id: 'quick', label: 'Go to File…', kbd: 'Ctrl+P', run: () => setPalette('files') },
    { id: 'search', label: 'Search: Find in Files', kbd: 'Ctrl+Shift+F', run: () => { setMainView('ide'); setView('search'); setSearchFocus((n) => n + 1); } },
    { id: 'explorer', label: 'View: Show Explorer', kbd: 'Ctrl+Shift+E', run: () => { setMainView('ide'); setView('explorer'); } },
    { id: 'sidebar', label: 'View: Toggle Sidebar', kbd: 'Ctrl+B', run: () => (mainView === 'home' ? setHomeSide((v) => !v) : setView((v) => (v ? null : 'explorer'))) },
    { id: 'terminal', label: 'View: Toggle Terminal', kbd: 'Ctrl+`', run: () => { setMainView('ide'); setPanelOpen((o) => !o); } },
    { id: 'agent', label: 'Kestrel: Focus Chat', kbd: 'Ctrl+I', run: showAgent },
    { id: 'agentToggle', label: 'Kestrel: Toggle Agent Panel', kbd: 'Ctrl+Alt+B', run: () => setAgentOpen((o) => !o) },
    { id: 'inline', label: 'Kestrel: Edit Selection Inline', kbd: 'Ctrl+K', run: () => editorRef.current?.openInline() },
    { id: 'addsel', label: 'Kestrel: Add Selection to Chat', kbd: 'Ctrl+L', run: addSelectionToChat },
    { id: 'mode', label: 'Kestrel: Toggle Agent / Ask Mode', kbd: 'Ctrl+.', run: () => updateSettings({ mode: settings.mode === 'agent' ? 'ask' : 'agent' }) },
    ...(info?.models || []).map((m) => ({ id: 'model-' + m.id, label: `Kestrel: Use ${m.name} (${m.tag})`, run: () => updateSettings({ model: m.id }) })),
    ...(info?.efforts || []).map((e) => ({ id: 'effort-' + e.id, label: `Kestrel: Effort ${e.name}`, run: () => updateSettings({ effort: e.id }) })),
    { id: 'settings', label: 'Preferences: Open Settings', kbd: 'Ctrl+,', run: () => setSettingsOpen('general') },
    { id: 'server', label: 'Preferences: Model Server (Unsloth)', run: () => setSettingsOpen('server') },
    { id: 'zoomin', label: 'View: Increase Editor Font Size', kbd: 'Ctrl+=', run: () => updateSettings({ fontSize: Math.min(28, settings.fontSize + 1) }) },
    { id: 'zoomout', label: 'View: Decrease Editor Font Size', kbd: 'Ctrl+-', run: () => updateSettings({ fontSize: Math.max(10, settings.fontSize - 1) }) },
    { id: 'about', label: 'Help: About KSTRL', run: () => setSettingsOpen('about') },
    { id: 'site', label: 'Help: Visit kstrlsi', run: () => api.shell.openExternal('https://kstrlsi.base44.app/') },
  ], [newChat, newProject, pickFolder, newUntitled, active, saveFile, tabs, closeTab, closeFolder, mainView, showAgent, addSelectionToChat, updateSettings, settings, info]);

  const cmd = (id) => commands.find((c) => c.id === id)?.run();

  useEffect(() => {
    const onKey = (e) => {
      if (!e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const inEditor = !!document.activeElement?.closest?.('.monaco-editor');
      const map = [
        [e.shiftKey && k === 'p', 'palette'],
        [!e.shiftKey && k === 'p', 'quick'],
        [e.shiftKey && k === 'f', 'search'],
        [e.shiftKey && k === 'e', 'explorer'],
        [e.shiftKey && k === 'h', 'home'],
        [!e.shiftKey && !e.altKey && k === 'e', 'ide'],
        [!e.shiftKey && !e.altKey && k === 'b', 'sidebar'],
        [e.altKey && k === 'b', 'agentToggle'],
        [k === '`', 'terminal'],
        [!e.shiftKey && k === 'i', 'agent'],
        [!e.shiftKey && k === 'o', 'open'],
        [k === ',', 'settings'],
        [e.shiftKey && k === 's', 'saveall'],
        [!e.shiftKey && k === 's' && !inEditor, 'save'],
        [!e.shiftKey && k === 'w', 'closetab'],
        [e.altKey && k === 'n', 'new'],
        [!e.altKey && !e.shiftKey && k === 'n', 'newchat'],
        [k === 'l' && !inEditor, 'addsel'],
        [k === '=' || k === '+', 'zoomin'],
        [k === '-', 'zoomout'],
      ];
      const hit = map.find(([cond]) => cond);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (hit[1] === 'palette') setPalette('commands');
      else cmd(hit[1]);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const menus = [
    { label: 'File', items: [
      { label: 'New Chat', kbd: 'Ctrl+N', run: newChat },
      { label: 'New Project from Scratch…', run: newProject },
      { label: 'Open Folder…', kbd: 'Ctrl+O', run: () => pickFolder() },
      { label: 'New File…', kbd: 'Ctrl+Alt+N', run: newUntitled },
      '-',
      { label: 'Save', kbd: 'Ctrl+S', run: () => cmd('save'), disabled: !active },
      { label: 'Save All', kbd: 'Ctrl+Shift+S', run: () => cmd('saveall') },
      '-',
      { label: 'Close Editor', kbd: 'Ctrl+W', run: () => cmd('closetab'), disabled: !active },
      { label: 'Close Folder', run: closeFolder, disabled: !workspace },
      '-',
      { label: 'Settings', kbd: 'Ctrl+,', run: () => setSettingsOpen('general') },
      { label: 'Exit', run: () => window.close() },
    ] },
    { label: 'Edit', items: [
      { label: 'Undo', kbd: 'Ctrl+Z', run: () => document.execCommand('undo') },
      { label: 'Redo', kbd: 'Ctrl+Y', run: () => document.execCommand('redo') },
      '-',
      { label: 'Find in Files', kbd: 'Ctrl+Shift+F', run: () => cmd('search') },
      { label: 'Edit Selection with Kestrel', kbd: 'Ctrl+K', run: () => cmd('inline'), disabled: !active || mainView !== 'ide' },
    ] },
    { label: 'View', items: [
      { label: 'Agents Home', kbd: 'Ctrl+Shift+H', run: () => setMainView('home') },
      { label: 'IDE', kbd: 'Ctrl+E', run: () => setMainView('ide') },
      '-',
      { label: 'Command Palette…', kbd: 'Ctrl+Shift+P', run: () => setPalette('commands') },
      { label: 'Go to File…', kbd: 'Ctrl+P', run: () => setPalette('files') },
      '-',
      { label: 'Toggle Sidebar', kbd: 'Ctrl+B', run: () => cmd('sidebar') },
      { label: 'Toggle Terminal', kbd: 'Ctrl+`', run: () => cmd('terminal') },
      { label: 'Toggle Kestrel Panel', kbd: 'Ctrl+Alt+B', run: () => cmd('agentToggle') },
    ] },
    { label: 'Help', items: [
      { label: 'Visit kstrlsi', run: () => cmd('site') },
      { label: 'All Commands & Shortcuts', run: () => setPalette('commands') },
      '-',
      { label: 'About KSTRL', run: () => setSettingsOpen('about') },
    ] },
  ];

  const [dragSide, startSide] = useDrag((e) => setSideW(Math.min(560, Math.max(170, e.clientX - 48))));
  const [dragHome, startHome] = useDrag((e) => setHomeW(Math.min(480, Math.max(220, e.clientX))));
  const [dragAgent, startAgent] = useDrag((e) => setAgentW(Math.min(window.innerWidth * 0.6, Math.max(320, window.innerWidth - e.clientX))));
  const [dragPanel, startPanel] = useDrag((e) => setPanelH(Math.min(window.innerHeight * 0.75, Math.max(120, window.innerHeight - e.clientY - 24))));

  const currentModel = info?.models.find((m) => m.id === settings.model);
  const isHome = mainView === 'home';
  const chatProps = {
    info, settings, onSettings: updateSettings, workspace, activePath: active, files, onOpenFile: openFile, onOpenDiff: setDiff,
    onOpenSettings: () => setSettingsOpen(settings.configured ? 'general' : 'server'), onToast: toast,
    onNewProject: newProject, onOpenFolder: () => pickFolder(), onOpenRecent: openRecent,
  };

  return (
    <div className="app">
      <div className="bg-orbs" aria-hidden="true"><span className="o1" /><span className="o2" /><span className="o3" /></div>
      <TitleBar menus={menus} />
      <div className="toolbar">
        <button className="icon-btn" title="Toggle Sidebar (Ctrl+B)" onClick={() => cmd('sidebar')}><PanelLeft size={16} /></button>
        <button className="icon-btn" title="Search (Ctrl+P)" onClick={() => setPalette('files')}><Search size={15} /></button>
        <span style={{ flex: isHome ? `0 0 ${Math.max(0, (homeSide ? homeW : 0) - 132)}px` : '0 0 8px' }} />
        <button className="icon-btn" title="Back" disabled={!store.canBack(chatState)} onClick={() => store.back()}><ArrowLeft size={15} /></button>
        <button className="icon-btn" title="Forward" disabled={!store.canForward(chatState)} onClick={() => store.forward()}><ArrowRight size={15} /></button>
        <span className="toolbar-title">{isHome ? (activeChat(chatState).items.length ? activeChat(chatState).title : '') : workspace ? workspace.name : ''}</span>
        <button className={'view-toggle' + (isHome ? '' : ' grad')} title={isHome ? 'Open the IDE (Ctrl+E)' : 'Back to Agents Home (Ctrl+Shift+H)'} onClick={() => setMainView(isHome ? 'ide' : 'home')}>
          {isHome ? 'IDE' : 'Agents'} <ArrowUpRight size={13} />
        </button>
        <button className="icon-btn" title="More" onClick={(e) => setMoreMenu(e.currentTarget)}><Ellipsis size={16} /></button>
        <button className="icon-btn" title="Toggle Kestrel Panel (Ctrl+Alt+B)" style={!isHome && agentOpen ? { color: 'var(--accent)' } : null} onClick={() => { if (isHome) { setMainView('ide'); setAgentOpen(true); } else setAgentOpen((o) => !o); }}><PanelRight size={16} /></button>
      </div>

      {isHome ? (
        <div className="body">
          {homeSide && (
            <>
              <HomeSidebar
                settings={settings}
                workspace={workspace}
                width={homeW}
                onNewChat={newChat}
                onOpenFolder={() => pickFolder()}
                onNewProject={newProject}
                onOpenRecent={openRecent}
                onCustomize={() => setSettingsOpen('kestrel')}
                onSettings={() => setSettingsOpen('general')}
                onServer={() => setSettingsOpen('server')}
                onSearch={() => setPalette('files')}
              />
              <div className={'resizer' + (dragHome ? ' dragging' : '')} onMouseDown={startHome} />
            </>
          )}
          <main className="home-main">
            <ChatView ref={homeChatRef} variant="home" {...chatProps} />
          </main>
        </div>
      ) : (
        <div className="body">
          <div className="activitybar glass-pane">
            <button className={'act' + (view === 'explorer' ? ' active' : '')} title="Explorer (Ctrl+Shift+E)" onClick={() => setView((v) => (v === 'explorer' ? null : 'explorer'))}><Files size={20} /></button>
            <button className={'act' + (view === 'search' ? ' active' : '')} title="Search (Ctrl+Shift+F)" onClick={() => { setView((v) => (v === 'search' ? null : 'search')); setSearchFocus((n) => n + 1); }}><Search size={20} /></button>
            <button className={'act' + (agentOpen ? ' active' : '')} title="Kestrel Agent (Ctrl+I)" onClick={() => setAgentOpen((o) => !o)}><Bot size={20} /></button>
            <button className={'act' + (panelOpen ? ' active' : '')} title="Terminal (Ctrl+`)" onClick={() => setPanelOpen((o) => !o)}><TerminalSquare size={20} /></button>
            <div className="spacer" />
            <button className="act" title="Settings (Ctrl+,)" onClick={() => setSettingsOpen('general')}><SettingsIcon size={20} /></button>
          </div>

          {view && (
            <>
              <div className="sidebar glass-pane" style={{ width: sideW }}>
                {view === 'explorer' ? (
                  <Explorer
                    workspace={workspace}
                    activePath={active}
                    onOpenFile={openFile}
                    onToast={toast}
                    onAddToChat={(p) => { setAgentOpen(true); setTimeout(() => agentRef.current?.addContext({ kind: 'file', path: p }), 40); }}
                    onDeleted={(p) => tabs.filter((t) => t.path === p || t.path.startsWith(p + '/')).forEach((t) => { disposeDoc(t.path); setTabs((ts) => ts.filter((x) => x.path !== t.path)); if (active === t.path) setActive(null); })}
                    onRenamed={(from) => tabs.filter((t) => t.path === from || t.path.startsWith(from + '/')).forEach((t) => { disposeDoc(t.path); setTabs((ts) => ts.filter((x) => x.path !== t.path)); if (active === t.path) setActive(null); })}
                  />
                ) : (
                  <SearchPanel workspace={workspace} onOpenAt={openFile} focusKey={searchFocus} />
                )}
                {!workspace && view === 'explorer' && <div style={{ padding: 14 }}><button className="btn grad" style={{ width: '100%' }} onClick={() => pickFolder()}>Open Folder</button></div>}
              </div>
              <div className={'resizer' + (dragSide ? ' dragging' : '')} onMouseDown={startSide} />
            </>
          )}

          <div className="main">
            {tabs.length === 0 && (
              <Welcome info={info} settings={settings} onOpenFolder={() => pickFolder()} onOpenRecent={openRecent} onNewChat={showAgent} onTerminal={() => setPanelOpen(true)} onPalette={() => setPalette('commands')} />
            )}
            <div style={{ display: tabs.length ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
              <EditorArea ref={editorRef} tabs={tabs} active={active} onActivate={setActive} onClose={closeTab} onDirtyChange={setDirty} onSave={saveFile} model={settings.model} fontSize={settings.fontSize} onToast={toast} onAddSelection={addSelectionToChat} />
            </div>
            {panelOpen && (
              <>
                <div className={'resizer h' + (dragPanel ? ' dragging' : '')} onMouseDown={startPanel} />
                <TerminalPanel height={panelH} workspace={workspace} onHide={() => setPanelOpen(false)} />
              </>
            )}
          </div>

          <div className={'resizer' + (dragAgent ? ' dragging' : '')} onMouseDown={startAgent} style={{ display: agentOpen ? 'block' : 'none' }} />
          <div className="agent-dock glass-pane" style={{ width: agentW, display: agentOpen ? 'flex' : 'none' }}>
            <ChatView ref={agentRef} variant="panel" {...chatProps} onClosePanel={() => setAgentOpen(false)} />
          </div>
        </div>
      )}

      <div className="statusbar">
        <span className="item"><GitBranch size={12} /> {workspace ? workspace.name : 'No folder'}</span>
        {!isHome && active && <span className="item">{languageFor(active)}</span>}
        <span className="spacer" />
        <button className="item" onClick={() => setSettingsOpen('server')} title="Model server">
          {settings.configured ? <CircleCheck size={12} color="var(--ok)" /> : <CircleAlert size={12} color="var(--warn)" />}
          {settings.configured ? (settings.provider === 'anthropic' ? 'Anthropic API' : 'Unsloth server') : 'Connect model server'}
        </button>
        <button className="item" onClick={() => setSettingsOpen('server')}><Sparkles size={12} color="var(--accent)" /><span className="kestrel">{currentModel?.name || '—'}</span></button>
        <span className="item">{settings.mode === 'ask' ? 'Ask' : 'Agent'}</span>
      </div>

      {moreMenu && (
        <Popover anchor={moreMenu} onClose={() => setMoreMenu(null)} width={240} below>
          {[
            ['Command Palette', () => setPalette('commands')],
            ['Model Server', () => setSettingsOpen('server')],
            ['Settings', () => setSettingsOpen('general')],
            ['Open Terminal', () => { setMainView('ide'); setPanelOpen(true); }],
            ['About KSTRL', () => setSettingsOpen('about')],
          ].map(([label, run]) => (
            <button key={label} className="opt" onClick={() => { setMoreMenu(null); run(); }}><div className="n" style={{ fontFamily: 'var(--sans)', fontWeight: 500 }}>{label}</div></button>
          ))}
        </Popover>
      )}
      {palette && <Palette mode={palette} files={files} commands={commands} onClose={() => setPalette(null)} onOpenFile={openFile} />}
      {settingsOpen && <SettingsModal info={info} settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(null)} initialTab={settingsOpen} />}
      {diff && <DiffModal diff={diff} onClose={() => setDiff(null)} onOpenFile={openFile} />}
      <div className="toast-wrap">{toasts.map((t) => <div key={t.id} className="toast glass-strong">{t.text}</div>)}</div>
    </div>
  );
}
