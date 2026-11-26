import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, FilePlus2, FolderPlus, RefreshCw, ChevronsDownUp, Folder, FolderOpen } from 'lucide-react';
import { colorFor } from '../lib/lang.js';

const api = window.kstrl;

export default function Explorer({ workspace, activePath, onOpenFile, onToast, onAddToChat, onDeleted, onRenamed }) {
  const [children, setChildren] = useState({}); // dir -> entries
  const [expanded, setExpanded] = useState(() => new Set(['.']));
  const [menu, setMenu] = useState(null); // { x, y, entry }
  const [editing, setEditing] = useState(null); // { mode: 'new-file'|'new-dir'|'rename', dir, entry }
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const load = useCallback(async (dir) => {
    try {
      const list = await api.fs.readDir(dir);
      setChildren((c) => ({ ...c, [dir]: list }));
    } catch {
      setChildren((c) => { const n = { ...c }; delete n[dir]; return n; });
    }
  }, []);

  useEffect(() => {
    setChildren({});
    setExpanded(new Set(['.']));
    if (workspace) load('.');
  }, [workspace, load]);

  // Refresh directories touched by file-system events.
  useEffect(() => api.fs.onTree(({ paths }) => {
    const dirs = new Set(['.']);
    for (const p of paths) {
      const parts = p.split('/');
      parts.pop();
      dirs.add(parts.join('/') || '.');
    }
    for (const d of dirs) if (expandedRef.current.has(d)) load(d);
  }), [load]);

  const refreshAll = () => { for (const d of expanded) load(d); };

  const toggle = (dir) => {
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(dir)) n.delete(dir);
      else { n.add(dir); load(dir); }
      return n;
    });
  };

  const parentOf = (p) => { const parts = p.split('/'); parts.pop(); return parts.join('/') || '.'; };
  const join = (dir, name) => (dir === '.' ? name : `${dir}/${name}`);

  const startNew = (mode, dir = '.') => {
    if (dir !== '.' && !expanded.has(dir)) toggle(dir);
    setEditing({ mode, dir });
    setMenu(null);
  };

  const commit = async (value) => {
    const e = editing;
    setEditing(null);
    if (!e || !value.trim()) return;
    try {
      if (e.mode === 'rename') {
        const to = join(parentOf(e.entry.path), value.trim());
        if (to === e.entry.path) return;
        await api.fs.rename(e.entry.path, to);
        onRenamed?.(e.entry.path, to);
        load(parentOf(e.entry.path));
      } else {
        const p = join(e.dir, value.trim());
        await api.fs.create(p, e.mode === 'new-dir');
        await load(e.dir);
        if (e.mode === 'new-file') onOpenFile(p);
      }
    } catch (err) { onToast(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
  };

  const remove = async (entry) => {
    setMenu(null);
    if (!confirm(`Delete ${entry.path}${entry.dir ? ' and everything inside it' : ''}?`)) return;
    try { await api.fs.delete(entry.path); onDeleted?.(entry.path); load(parentOf(entry.path)); }
    catch (err) { onToast(String(err.message || err)); }
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const editRow = (depth, mode, initial = '') => (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className="chev" />
      {mode === 'new-dir' ? <Folder size={14} color="var(--text-3)" /> : <span className="dot" style={{ background: '#8a8a93' }} />}
      <input
        autoFocus
        defaultValue={initial}
        onFocus={(e) => { const i = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, i > 0 ? i : e.target.value.length); }}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(e.currentTarget.value); if (e.key === 'Escape') setEditing(null); }}
        onBlur={(e) => commit(e.currentTarget.value)}
      />
    </div>
  );

  const renderDir = (dir, depth) => {
    const list = children[dir];
    if (!list) return null;
    return (
      <>
        {editing && editing.mode !== 'rename' && editing.dir === dir && editRow(depth, editing.mode)}
        {list.map((e) => (
          <React.Fragment key={e.path}>
            {editing?.mode === 'rename' && editing.entry.path === e.path ? (
              editRow(depth, e.dir ? 'new-dir' : 'new-file', e.name)
            ) : (
              <div
                className={'tree-row' + (activePath === e.path ? ' active' : '') + (e.ignored ? ' ignored' : '')}
                style={{ paddingLeft: 8 + depth * 12 }}
                title={e.path}
                onClick={() => (e.dir ? toggle(e.path) : onOpenFile(e.path))}
                onContextMenu={(ev) => { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, entry: e }); }}
                draggable={!e.dir}
                onDragStart={(ev) => ev.dataTransfer.setData('text/kstrl-path', e.path)}
              >
                <span className="chev">{e.dir ? (expanded.has(e.path) ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : null}</span>
                {e.dir ? (expanded.has(e.path) ? <FolderOpen size={14} color="#c9a86a" /> : <Folder size={14} color="#c9a86a" />) : <span className="dot" style={{ background: colorFor(e.path) }} />}
                <span className="name">{e.name}</span>
              </div>
            )}
            {e.dir && expanded.has(e.path) && renderDir(e.path, depth + 1)}
          </React.Fragment>
        ))}
      </>
    );
  };

  return (
    <>
      <div className="sidebar-head">
        <span className="label">{workspace ? workspace.name : 'Explorer'}</span>
        <div className="actions">
          <button className="icon-btn" title="New File" disabled={!workspace} onClick={() => startNew('new-file')}><FilePlus2 size={15} /></button>
          <button className="icon-btn" title="New Folder" disabled={!workspace} onClick={() => startNew('new-dir')}><FolderPlus size={15} /></button>
          <button className="icon-btn" title="Refresh" disabled={!workspace} onClick={refreshAll}><RefreshCw size={14} /></button>
          <button className="icon-btn" title="Collapse All" disabled={!workspace} onClick={() => setExpanded(new Set(['.']))}><ChevronsDownUp size={15} /></button>
        </div>
      </div>
      <div className="tree" onContextMenu={(ev) => { if (ev.target === ev.currentTarget && workspace) { ev.preventDefault(); setMenu({ x: ev.clientX, y: ev.clientY, entry: { path: '.', dir: true, root: true } }); } }}>
        {workspace ? renderDir('.', 0) : <div style={{ padding: 14, color: 'var(--text-3)', fontSize: 12.5 }}>No folder opened.</div>}
      </div>
      {menu && (
        <div className="dropdown ctx-menu glass-strong" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menu.entry.dir && <button className="item" onClick={() => startNew('new-file', menu.entry.path)}>New File…</button>}
          {menu.entry.dir && <button className="item" onClick={() => startNew('new-dir', menu.entry.path)}>New Folder…</button>}
          {!menu.entry.dir && <button className="item" onClick={() => { onOpenFile(menu.entry.path); setMenu(null); }}>Open</button>}
          {!menu.entry.dir && <button className="item" onClick={() => { onAddToChat(menu.entry.path); setMenu(null); }}>Add to Kestrel Chat <span className="kbd">@</span></button>}
          <div className="sep" />
          <button className="item" onClick={() => { api.shell.reveal(menu.entry.path); setMenu(null); }}>Reveal in File Explorer</button>
          <button className="item" onClick={() => { navigator.clipboard.writeText(menu.entry.path); setMenu(null); }}>Copy Relative Path</button>
          {!menu.entry.root && <div className="sep" />}
          {!menu.entry.root && <button className="item" onClick={() => { setEditing({ mode: 'rename', entry: menu.entry }); setMenu(null); }}>Rename… <span className="kbd">F2</span></button>}
          {!menu.entry.root && <button className="item" onClick={() => remove(menu.entry)}>Delete</button>}
        </div>
      )}
    </>
  );
}
