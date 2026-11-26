import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Plus, X, ChevronDown } from 'lucide-react';

const api = window.kstrl;

function XTerm({ id, visible, ptyMode }) {
  const host = useRef(null);
  const fit = useRef(null);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 8000,
      theme: {
        background: '#0e0e0e', foreground: '#e6e6e6', cursor: '#ffffff', cursorAccent: '#0e0e0e',
        selectionBackground: '#ffffff33', black: '#1b1b1b', red: '#ff5c5c', green: '#4ade80', yellow: '#f2c879',
        blue: '#7fb4ff', magenta: '#d68cff', cyan: '#7fd3ff', white: '#e6e6e6', brightBlack: '#5e5e5e',
        brightRed: '#ff7a7a', brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#a5c8ff',
        brightMagenta: '#e3b0ff', brightCyan: '#a5e4ff', brightWhite: '#ffffff',
      },
    });
    const f = new FitAddon();
    fit.current = f;
    term.loadAddon(f);
    term.open(host.current);
    // Ctrl+C copies when text is selected; Ctrl+V pastes.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
      if (e.ctrlKey && e.key === 'v') { navigator.clipboard.readText().then((t) => api.term.write(id, t)); return false; }
      if (e.ctrlKey && (e.key === '`' || e.key === 'p' || e.key === 'P' || e.key === 'b' || e.key === 'i' || e.key === 'l')) return false;
      return true;
    });

    let line = '';
    term.onData((d) => {
      if (ptyMode) { api.term.write(id, d); return; }
      // Pipe fallback: local line editing.
      for (const ch of d) {
        if (ch === '\r') { term.write('\r\n'); api.term.write(id, line + '\r'); line = ''; }
        else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); term.write('\b \b'); } }
        else if (ch >= ' ') { line += ch; term.write(ch); }
      }
    });
    const offData = api.term.onData((p) => p.id === id && term.write(p.data));
    const offExit = api.term.onExit((p) => p.id === id && term.write(`\r\n\x1b[90m[process exited with code ${p.code}]\x1b[0m\r\n`));
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return;
      try { f.fit(); api.term.resize(id, term.cols, term.rows); } catch {}
    });
    ro.observe(host.current);
    setTimeout(() => { try { f.fit(); api.term.resize(id, term.cols, term.rows); term.focus(); } catch {} }, 30);
    host.current.__term = term;
    return () => { ro.disconnect(); offData(); offExit(); term.dispose(); };
  }, [id, ptyMode]);

  useEffect(() => {
    if (visible) setTimeout(() => { try { fit.current?.fit(); host.current?.__term?.focus(); } catch {} }, 20);
  }, [visible]);

  return <div ref={host} className="term-host" style={{ display: visible ? 'block' : 'none', height: '100%' }} />;
}

export default function TerminalPanel({ height, workspace, onHide, focusKey }) {
  const [terms, setTerms] = useState([]);
  const [active, setActive] = useState(null);

  const create = async () => {
    const t = await api.term.create({ cols: 120, rows: 20 });
    setTerms((ts) => [...ts, { id: t.id, name: t.shell.replace(/\.exe$/i, '').split(/[\\/]/).pop(), pty: t.pty }]);
    setActive(t.id);
  };

  useEffect(() => { if (terms.length === 0) create(); /* first terminal */ // eslint-disable-next-line
  }, []);

  // Restart terminals in the new folder when the workspace changes.
  const firstWs = useRef(true);
  useEffect(() => {
    if (firstWs.current) { firstWs.current = false; return; }
    terms.forEach((t) => api.term.kill(t.id));
    setTerms([]);
    create();
    // eslint-disable-next-line
  }, [workspace?.root]);

  useEffect(() => { if (focusKey) document.querySelector('.term-host[style*="block"] textarea')?.focus(); }, [focusKey]);

  const kill = (id) => {
    api.term.kill(id);
    setTerms((ts) => {
      const n = ts.filter((t) => t.id !== id);
      if (active === id) setActive(n.length ? n[n.length - 1].id : null);
      if (n.length === 0) onHide();
      return n;
    });
  };

  return (
    <div className="panel" style={{ height }}>
      <div className="panel-head">
        {terms.map((t, i) => (
          <button key={t.id} className={'panel-tab' + (t.id === active ? ' active' : '')} onClick={() => setActive(t.id)}>
            {i === 0 ? 'Terminal' : `Terminal ${i + 1}`} <span style={{ opacity: 0.5 }}>{t.name}</span>
            <span className="x" onClick={(e) => { e.stopPropagation(); kill(t.id); }}><X size={11} /></span>
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="icon-btn" title="New Terminal" onClick={create}><Plus size={15} /></button>
        <button className="icon-btn" title="Hide Panel (Ctrl+`)" onClick={onHide}><ChevronDown size={15} /></button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {terms.map((t) => <XTerm key={t.id} id={t.id} ptyMode={t.pty} visible={t.id === active} />)}
      </div>
    </div>
  );
}
