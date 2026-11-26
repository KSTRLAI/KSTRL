import React, { useEffect, useRef, useState } from 'react';
import { X, KeyRound, CircleCheck, FolderOpen, MessageSquarePlus, TerminalSquare, Command, ExternalLink, Check } from 'lucide-react';
import { monaco } from '../lib/monaco.js';
import { languageFor } from '../lib/lang.js';

const api = window.kstrl;
const SITE = 'https://kstrlsi.base44.app/';

export function SettingsModal({ info, settings, onChange, onClose, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab);
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  const models = info?.models || [];

  const saveKey = async () => {
    await onChange({ apiKey: key });
    setKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="modal glass-strong" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2><img src="./logo.png" alt="" /> Settings</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-tabs">
          {[['general', 'General'], ['models', 'Models'], ['kestrel', 'Kestrel'], ['about', 'About']].map(([id, label]) => (
            <button key={id} className={'panel-tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'general' && (
            <>
              <div className="field">
                <div className="label" style={{ marginBottom: 8 }}>API key</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="input" type="password" placeholder={settings.hasApiKey ? '•••••••••••••••• (saved — paste to replace)' : 'Paste your API key'} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key && saveKey()} />
                  <button className="btn primary" disabled={!key} onClick={saveKey}><KeyRound size={13} /> Save</button>
                </div>
                <div className="hint">
                  {saved ? <span className="status-ok"><CircleCheck size={13} /> Key saved</span> : settings.hasApiKey ? <span className="status-ok"><CircleCheck size={13} /> A key is configured</span> : 'Required to use the Colossus models.'}
                  {' '}The Colossus models run on the Anthropic API — use an Anthropic API key. It is encrypted with Windows' secure storage and never leaves this machine except to call the model service.
                  {settings.hasApiKey && <> <button className="btn ghost" style={{ height: 20, padding: '0 6px', fontSize: 11 }} onClick={() => onChange({ apiKey: '' })}>Remove key</button></>}
                </div>
              </div>
              <div className="field">
                <div className="label" style={{ marginBottom: 8 }}>Custom endpoint (optional)</div>
                <input className="input" placeholder="https://api.anthropic.com" defaultValue={settings.baseURL} onBlur={(e) => onChange({ baseURL: e.target.value.trim() })} />
                <div className="hint">Route requests through a gateway or proxy that speaks the Anthropic Messages API. Leave empty for the default.</div>
              </div>
              <div className="toggle-row glass-soft">
                <div>
                  <div className="label" style={{ color: 'var(--text)' }}>Auto-run commands</div>
                  <div className="hint" style={{ marginTop: 4 }}>Let Kestrel run terminal commands without asking each time. Off by default.</div>
                </div>
                <button className={'toggle' + (settings.autoRunCommands ? ' on' : '')} onClick={() => onChange({ autoRunCommands: !settings.autoRunCommands })} />
              </div>
              <div className="toggle-row glass-soft">
                <div>
                  <div className="label" style={{ color: 'var(--text)' }}>Editor font size</div>
                  <div className="hint" style={{ marginTop: 4 }}>Ctrl+= / Ctrl+- also work.</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn" onClick={() => onChange({ fontSize: Math.max(10, settings.fontSize - 1) })}>−</button>
                  <span className="mono" style={{ width: 24, textAlign: 'center' }}>{settings.fontSize}</span>
                  <button className="btn" onClick={() => onChange({ fontSize: Math.min(28, settings.fontSize + 1) })}>+</button>
                </div>
              </div>
            </>
          )}
          {tab === 'models' && (
            <>
              <div className="hint" style={{ marginTop: 0, marginBottom: 14 }}>
                Each Colossus model is served by a backend model on the Anthropic API. Advanced: override the backend model ID per Colossus model. Leave a field empty to use the default.
              </div>
              {models.map((m) => (
                <div key={m.id} className="model-row glass-soft">
                  <div>
                    <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{m.name}</div>
                    <div className="label" style={{ fontSize: 9, color: 'var(--accent)', marginTop: 3 }}>{m.tag}</div>
                  </div>
                  <input
                    className="input mono"
                    style={{ fontSize: 12 }}
                    placeholder={m.backend}
                    defaultValue={settings.backendOverrides?.[m.id] || ''}
                    onBlur={(e) => onChange({ backendOverrides: { ...settings.backendOverrides, [m.id]: e.target.value.trim() || undefined } })}
                  />
                </div>
              ))}
            </>
          )}
          {tab === 'kestrel' && (
            <div className="field">
              <div className="label" style={{ marginBottom: 8 }}>Rules for Kestrel</div>
              <textarea className="input" rows={8} placeholder={'e.g.\n- Use TypeScript and functional React components\n- Prefer pnpm\n- Write tests with Vitest'} defaultValue={settings.customInstructions} onBlur={(e) => onChange({ customInstructions: e.target.value })} />
              <div className="hint">Added to every Kestrel conversation, in Agent and Ask mode.</div>
            </div>
          )}
          {tab === 'about' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
              <img src="./icon.png" alt="" style={{ width: 84, borderRadius: 20 }} />
              <div className="mono" style={{ letterSpacing: '.4em', fontSize: 18, paddingLeft: '.4em' }}>KSTRL</div>
              <div className="mono" style={{ color: 'var(--text-3)', fontSize: 11.5 }}>Version {info?.version} · {info?.platform === 'win32' ? 'Windows' : info?.platform}</div>
              <p className="mono" style={{ color: 'var(--text-2)', fontSize: 12, maxWidth: 440, lineHeight: 1.6 }}>
                An AI-native coding environment. Kestrel reads your project, edits files and runs commands — powered by Colossus 2, 2.2 UC, 2.3 and the flagship Colossus 3.
              </p>
              <div className="gold-glass" style={{ borderRadius: 20, padding: 18, width: '100%', maxWidth: 440, textAlign: 'left' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div className="mono" style={{ fontWeight: 600, letterSpacing: '.2em', fontSize: 13 }}>KSTRL MAX</div>
                    <div className="mono" style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>Everything Kestrel can do, at full effort.</div>
                  </div>
                </div>
                <ul className="mono" style={{ fontSize: 11, padding: 0, listStyle: 'none', margin: '12px 0 0' }}>
                  {['Max effort on every model', 'Colossus 3 flagship access', 'Early access to new models'].map((t) => <li key={t} style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}><Check size={12} /> {t}</li>)}
                </ul>
                <button className="btn" style={{ width: '100%', marginTop: 12, background: '#111', color: '#fff', borderColor: '#111' }} onClick={() => api.shell.openExternal(SITE)}>Visit kstrlsi <ExternalLink size={12} /></button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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
