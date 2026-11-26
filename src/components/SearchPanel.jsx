import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CaseSensitive, Regex } from 'lucide-react';
import { colorFor } from '../lib/lang.js';

export default function SearchPanel({ workspace, onOpenAt, focusKey }) {
  const [q, setQ] = useState('');
  const [glob, setGlob] = useState('');
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, [focusKey]);

  useEffect(() => {
    if (!workspace || !q) { setResults([]); setErr(''); return; }
    const t = setTimeout(async () => {
      setBusy(true);
      try { setResults(await window.kstrl.fs.search(q, { regex, caseSensitive: cs, glob })); setErr(''); }
      catch (e) { setErr(String(e.message || e).replace(/^.*Error: /, '')); setResults([]); }
      setBusy(false);
    }, 250);
    return () => clearTimeout(t);
  }, [q, glob, regex, cs, workspace]);

  const grouped = useMemo(() => {
    const m = new Map();
    for (const r of results) { if (!m.has(r.path)) m.set(r.path, []); m.get(r.path).push(r); }
    return [...m.entries()];
  }, [results]);

  const highlight = (text) => {
    try {
      const re = new RegExp(regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? '' : 'i');
      const m = text.match(re);
      if (!m || !m[0]) return text;
      const i = m.index;
      const start = Math.max(0, i - 30);
      return (<>{start > 0 ? '…' : ''}{text.slice(start, i)}<b>{m[0]}</b>{text.slice(i + m[0].length)}</>);
    } catch { return text; }
  };

  return (
    <>
      <div className="sidebar-head"><span className="label">Search</span></div>
      <div className="search-panel">
        <div style={{ position: 'relative' }}>
          <input ref={inputRef} className="input" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingRight: 60 }} />
          <div className="opts" style={{ position: 'absolute', right: 4, top: 5 }}>
            <button className="icon-btn" title="Match Case" style={cs ? { color: 'var(--accent)' } : null} onClick={() => setCs(!cs)}><CaseSensitive size={15} /></button>
            <button className="icon-btn" title="Use Regular Expression" style={regex ? { color: 'var(--accent)' } : null} onClick={() => setRegex(!regex)}><Regex size={14} /></button>
          </div>
        </div>
        <input className="input" placeholder="Files to include (e.g. *.ts)" value={glob} onChange={(e) => setGlob(e.target.value)} />
        <div style={{ fontSize: 11.5, color: err ? '#ffb4b4' : 'var(--text-3)' }}>
          {err || (!workspace ? 'Open a folder to search.' : busy ? 'Searching…' : q ? `${results.length}${results.length >= 1000 ? '+' : ''} results in ${grouped.length} files` : '')}
        </div>
      </div>
      <div className="search-results">
        {grouped.map(([path, hits]) => (
          <div key={path}>
            <div className="sr-file" onClick={() => onOpenAt(path, hits[0].line)}>
              <span className="dot" style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(path) }} />
              {path.split('/').pop()} <span style={{ color: 'var(--text-3)', fontWeight: 400, fontSize: 11 }}>{path}</span>
              <span className="count">{hits.length}</span>
            </div>
            {hits.slice(0, 50).map((h) => (
              <div key={h.line} className="sr-line" onClick={() => onOpenAt(path, h.line)}>{highlight(h.text.trim())}</div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
