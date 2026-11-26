import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { monaco } from '../lib/monaco.js';
import { languageFor } from '../lib/lang.js';

const api = window.kstrl;
const SITE = 'https://kstrlsi.base44.app/';

export function DiffModal({ diff, onClose, onOpenFile }) {
  const host = useRef(null);
  useEffect(() => {
    const lang = languageFor(diff.path);
    const original = monaco.editor.createModel(diff.before ?? '', lang);
    const modified = monaco.editor.createModel(diff.after ?? '', lang);
    const editor = monaco.editor.createDiffEditor(host.current, {
      theme: 'kstrl-dark', automaticLayout: true, readOnly: true, renderSideBySide: true,
      fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 13, minimap: { enabled: false },
      scrollBeyondLastLine: false, hideUnchangedRegions: { enabled: true },
    });
    editor.setModel({ original, modified });
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); editor.dispose(); original.dispose(); modified.dispose(); };
  }, [diff, onClose]);
  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="diff-modal glass-strong" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="mono">{diff.path} <span style={{ color: 'var(--text-3)' }}>— changes by Kestrel</span></h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn" onClick={() => { onOpenFile(diff.path); onClose(); }}>Open file</button>
            <button className="icon-btn" onClick={onClose}><X size={16} /></button>
          </div>
        </div>
        <div ref={host} style={{ flex: 1, minHeight: 0 }} />
      </div>
    </div>
  );
}

// Small text-input dialog (Electron has no window.prompt).
export function InputDialog({ title, desc, value = '', placeholder, button = 'OK', run, onClose, onError }) {
  const [v, setV] = useState(value);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!v.trim() || busy) return;
    setBusy(true);
    try { await run(v.trim()); onClose(); } catch (e) { onError?.(e); setBusy(false); }
  };
  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="input-dialog glass-strong" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {desc && <p>{desc}</p>}
        <input className="input" autoFocus value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)}
          onFocus={(e) => { const i = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, i > 0 ? i : e.target.value.length); }}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }} />
        <div className="row">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn light" disabled={!v.trim() || busy} onClick={submit}>{busy ? <Loader2 size={13} className="spin" /> : null}{button}</button>
        </div>
      </div>
    </div>
  );
}
