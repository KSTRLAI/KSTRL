import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ArrowUpFromLine, ArrowDownToLine, Plus, Minus, Undo2, Sparkles, Loader2, GitBranch, Check } from 'lucide-react';
import { colorFor } from '../lib/lang.js';

const api = window.kstrl;
const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const LABEL = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', '?': 'U' };
const base = (p) => p.split('/').pop();
const dir = (p) => p.split('/').slice(0, -1).join('/');

// Source Control: branch, staged and unstaged changes, commit (with an AI-written message), push and pull.
export default function GitPanel({ workspace, onOpenDiff, onToast }) {
  const [st, setSt] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(null); // which action is running

  const refresh = useCallback(async () => { try { setSt(await api.git.status()); } catch (e) { setSt({ repo: false, error: clean(e) }); } }, []);
  useEffect(() => { refresh(); }, [refresh, workspace?.root]);
  useEffect(() => {
    let t;
    const off = api.fs.onTree(() => { clearTimeout(t); t = setTimeout(refresh, 600); });
    window.addEventListener('focus', refresh);
    return () => { off(); clearTimeout(t); window.removeEventListener('focus', refresh); };
  }, [refresh]);

  const run = async (name, fn, ok) => {
    setBusy(name);
    try { const r = await fn(); if (r && typeof r === 'object' && 'repo' in r) setSt(r); else await refresh(); if (ok) onToast(ok); return r; }
    catch (e) { onToast(clean(e)); return null; }
    finally { setBusy(null); }
  };

  if (!workspace) return <div className="git-empty">Open a project to use source control.</div>;
  if (!st) return <div className="git-empty"><Loader2 size={14} className="spin" /></div>;
  if (!st.repo) return (
    <div className="git-empty">
      {st.error || 'This folder isn’t a Git repository yet.'}
      {!st.error && <button className="btn light" style={{ marginTop: 12, width: '100%' }} onClick={() => run('init', api.git.init, 'Repository created')}>Initialize Repository</button>}
    </div>
  );

  const staged = st.files.filter((f) => f.index !== ' ' && f.index !== '?');
  const changes = st.files.filter((f) => f.work !== ' ' || f.index === '?');
  const total = st.files.length;

  const row = (f, isStaged) => {
    const code = isStaged ? f.index : f.index === '?' ? '?' : f.work;
    return (
      <div key={(isStaged ? 's:' : 'w:') + f.path} className="git-row" title={f.path} onClick={async () => { try { onOpenDiff(await api.git.diff(f.path, isStaged)); } catch (e) { onToast(clean(e)); } }}>
        <span className="dot" style={{ background: colorFor(f.path) }} />
        <span className="nm">{base(f.path)}</span>
        <span className="dir">{dir(f.path)}</span>
        <span className="acts" onClick={(e) => e.stopPropagation()}>
          {isStaged
            ? <button className="icon-btn" title="Unstage" onClick={() => run('row', () => api.git.unstage([f.path]))}><Minus size={13} /></button>
            : <>
              {f.index !== '?' && <button className="icon-btn" title="Discard changes" onClick={() => confirm(`Discard your changes to ${f.path}? This can't be undone.`) && run('row', () => api.git.discard([f.path]))}><Undo2 size={13} /></button>}
              <button className="icon-btn" title="Stage" onClick={() => run('row', () => api.git.stage([f.path]))}><Plus size={13} /></button>
            </>}
        </span>
        <span className={'st st-' + (code === '?' ? 'U' : code)}>{LABEL[code] || code}</span>
      </div>
    );
  };

  return (
    <>
      <div className="sidebar-head">
        <span className="label">Source Control</span>
        <div className="actions">
          <button className="icon-btn" title="Pull" disabled={!!busy} onClick={() => run('pull', api.git.pull, 'Pulled')}>{busy === 'pull' ? <Loader2 size={14} className="spin" /> : <ArrowDownToLine size={14} />}</button>
          <button className="icon-btn" title="Push" disabled={!!busy} onClick={() => run('push', api.git.push, 'Pushed')}>{busy === 'push' ? <Loader2 size={14} className="spin" /> : <ArrowUpFromLine size={14} />}</button>
          <button className="icon-btn" title="Refresh" onClick={refresh}><RefreshCw size={14} /></button>
        </div>
      </div>
      <div className="git-panel">
        <div className="git-branch"><GitBranch size={13} /> {st.branch || 'main'}{(st.ahead > 0 || st.behind > 0) && <span className="ab">{st.ahead ? `↑${st.ahead}` : ''} {st.behind ? `↓${st.behind}` : ''}</span>}</div>
        <div className="git-msg">
          <textarea className="input" rows={3} placeholder={`Message (${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter to commit)`} value={msg} onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit(); }} />
          <button className="icon-btn gen" title="Write a commit message with Kestrel" disabled={!!busy || !total} onClick={async () => { const m = await run('msg', api.git.message); if (m) setMsg(m); }}>
            {busy === 'msg' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
          </button>
        </div>
        <button className="btn light git-commit" disabled={!!busy || !total || !msg.trim()} onClick={commit}>
          {busy === 'commit' ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Commit{staged.length ? '' : ' All'} to {st.branch || 'main'}
        </button>
        {st.ahead > 0 && !busy && <button className="btn git-sync" onClick={() => run('push', api.git.push, 'Pushed')}><ArrowUpFromLine size={13} /> Push {st.ahead} commit{st.ahead > 1 ? 's' : ''}</button>}

        {staged.length > 0 && (
          <div className="git-sec">
            <div className="git-sec-h"><span>Staged Changes</span><span className="n">{staged.length}</span><button className="icon-btn" title="Unstage all" onClick={() => run('row', () => api.git.unstage(staged.map((f) => f.path)))}><Minus size={13} /></button></div>
            {staged.map((f) => row(f, true))}
          </div>
        )}
        <div className="git-sec">
          <div className="git-sec-h"><span>Changes</span><span className="n">{changes.length}</span>{changes.length > 0 && <button className="icon-btn" title="Stage all" onClick={() => run('row', () => api.git.stage(changes.map((f) => f.path)))}><Plus size={13} /></button>}</div>
          {changes.length ? changes.map((f) => row(f, false)) : <div className="git-none">No changes</div>}
        </div>
      </div>
    </>
  );

  async function commit() {
    if (!msg.trim() || busy) return;
    const r = await run('commit', () => api.git.commit(msg), 'Committed');
    if (r) setMsg('');
  }
}
