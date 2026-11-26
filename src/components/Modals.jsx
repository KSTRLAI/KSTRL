import React, { useEffect, useRef, useState } from 'react';
import { X, KeyRound, CircleCheck, FolderOpen, MessageSquarePlus, TerminalSquare, Command, ExternalLink, Check, Server, Cloud, PlugZap, Loader2 } from 'lucide-react';
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

export function Welcome({ info, settings, onOpenFolder, onOpenRecent, onNewChat, onTerminal, onPalette }) {
  const models = info?.models || [];
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="hero">
          <img src="./logo.png" alt="KSTRL" />
          <h1>KSTRL</h1>
          <div className="tagline">The AI coding environment. Built to move at the speed your task needs — from a quick fix to an afternoon of deep work.</div>
        </div>
        <div className="grid">
          <div className="card glass">
            <h3 className="label">Start</h3>
            <button className="action" onClick={onOpenFolder}><span className="ic"><FolderOpen size={16} /></span><span><div className="t">Open Folder</div><div className="d">Ctrl+O · work on an existing project</div></span></button>
            <button className="action" onClick={onNewChat}><span className="ic"><MessageSquarePlus size={16} /></span><span><div className="t">Ask Kestrel</div><div className="d">Ctrl+I · build something new with the agent</div></span></button>
            <button className="action" onClick={onTerminal}><span className="ic"><TerminalSquare size={16} /></span><span><div className="t">New Terminal</div><div className="d">Ctrl+` · PowerShell in the KSTRL environment</div></span></button>
            <button className="action" onClick={onPalette}><span className="ic"><Command size={16} /></span><span><div className="t">Command Palette</div><div className="d">Ctrl+Shift+P · every action, one search away</div></span></button>
          </div>
          <div className="card glass">
            <h3 className="label">Recent</h3>
            <div className="recent">
              {settings.recentFolders?.length ? settings.recentFolders.map((f) => (
                <button key={f} onClick={() => onOpenRecent(f)}>
                  <span>{f.split(/[\\/]/).pop()}</span>
                  <span className="p">{f}</span>
                </button>
              )) : <div style={{ color: 'var(--text-3)', fontSize: 12.5, padding: 10 }}>No recent folders yet.</div>}
            </div>
          </div>
        </div>
        <div className="model-list">
          {models.map((m) => (
            <div key={m.id} className={'model-chip glass-soft' + (m.tag === 'Flagship' ? ' flag' : '')}>
              <div className="n">{m.name}</div>
              <div className="t">{m.tag}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
