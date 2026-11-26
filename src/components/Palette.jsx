import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, ChevronRight } from 'lucide-react';

// Fuzzy subsequence score: lower is better, -1 = no match.
function score(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0, s = 0, last = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return -1;
    s += idx - last - 1;
    last = idx;
    ti = idx + 1;
  }
  const base = t.split('/').pop();
  if (base.includes(q)) s -= 50;
  return s + t.length * 0.01;
}

export default function Palette({ mode, files, commands, onClose, onOpenFile }) {
  const [q, setQ] = useState(mode === 'commands' ? '>' : '');
  const [sel, setSel] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const isCmd = q.startsWith('>');

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo(() => {
    if (isCmd) {
      const query = q.slice(1).trim();
      return commands
        .map((c) => ({ c, s: score(query, c.label) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s)
        .slice(0, 60)
        .map(({ c }) => ({ key: c.id, label: c.label, kbd: c.kbd, run: c.run }));
    }
    return files
      .map((f) => ({ f, s: score(q.trim(), f) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => a.s - b.s)
      .slice(0, 80)
      .map(({ f }) => ({ key: f, label: f.split('/').pop(), sub: f, run: () => onOpenFile(f), file: true }));
  }, [q, files, commands, isCmd, onOpenFile]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => { listRef.current?.children[sel]?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const run = (it) => { onClose(); it && setTimeout(() => it.run(), 0); };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="palette glass-strong" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={q}
          placeholder={isCmd ? 'Type a command' : 'Search files by name (type > for commands)'}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') run(items[sel]);
          }}
        />
        <div className="list" ref={listRef}>
          {items.length === 0 && <div className="it sub" style={{ color: 'var(--text-3)' }}>{files.length === 0 && !isCmd ? 'Open a folder to search files' : 'No results'}</div>}
          {items.map((it, i) => (
            <button key={it.key} className={'it' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => run(it)}>
              {it.file ? <FileCode2 size={14} color="var(--text-3)" /> : <ChevronRight size={14} color="var(--accent)" />}
              <span>{it.label}</span>
              {it.sub && <span className="sub">{it.sub}</span>}
              {it.kbd && <span className="kbd">{it.kbd}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
