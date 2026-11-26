import React, { useEffect, useRef, useState } from 'react';
import { X, KeyRound, CircleCheck, FolderOpen, MessageSquarePlus, TerminalSquare, Command, ExternalLink, Check, Server, Cloud, PlugZap, Loader2 } from 'lucide-react';
import { monaco } from '../lib/monaco.js';
import { languageFor } from '../lib/lang.js';

const api = window.kstrl;
const SITE = 'https://kstrlsi.base44.app/';

function ServerTab({ info, settings, onChange }) {
  const models = info?.models || [];
  const provider = settings.provider === 'anthropic' ? 'anthropic' : 'unsloth';
  const [url, setUrl] = useState(settings.unslothURL || '');
  const [key, setKey] = useState('');
  const [akey, setAkey] = useState('');
  const [test, setTest] = useState(null); // { busy } | { ok, models, url } | { ok:false, error }

  const runTest = async () => {
    setTest({ busy: true });
    await onChange({ unslothURL: url.trim(), ...(key ? { unslothKey: key } : {}) });
    setKey('');
    setTest(await api.server.test({}));
  };

  useEffect(() => { if (provider === 'unsloth' && settings.unslothURL) api.server.test({}).then(setTest); }, []); // eslint-disable-line

  const serverModels = test?.ok ? test.models : [];

  return (
    <>
      <div className="seg glass-soft">
        <button className={provider === 'unsloth' ? 'on grad' : ''} onClick={() => onChange({ provider: 'unsloth' })}><Server size={14} /> Unsloth server</button>
        <button className={provider === 'anthropic' ? 'on grad' : ''} onClick={() => onChange({ provider: 'anthropic' })}><Cloud size={14} /> Anthropic API</button>
      </div>

      {provider === 'unsloth' ? (
        <>
          <div className="field">
            <div className="label" style={{ marginBottom: 8 }}>Server URL</div>
            <input className="input mono" placeholder="http://192.168.1.50:8000" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() !== (settings.unslothURL || '') && onChange({ unslothURL: url.trim() })} onKeyDown={(e) => e.key === 'Enter' && runTest()} />
            <div className="hint">The address of your Unsloth server. KSTRL talks to its OpenAI-compatible API (<span className="mono">/v1/chat/completions</span>); "/v1" is added automatically.</div>
          </div>
          <div className="field">
            <div className="label" style={{ marginBottom: 8 }}>API key <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-3)' }}>(optional)</span></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="password" placeholder={settings.hasUnslothKey ? '•••••••••••• (saved — paste to replace)' : 'Only if your server requires one'} value={key} onChange={(e) => setKey(e.target.value)} />
              {settings.hasUnslothKey && <button className="btn" onClick={() => onChange({ unslothKey: '' })}>Remove</button>}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
            <button className="btn grad" disabled={!url.trim() || test?.busy} onClick={runTest}>{test?.busy ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Test connection</button>
            {test && !test.busy && (test.ok
              ? <span className="status-ok"><CircleCheck size={13} /> Connected · {test.models.length} model{test.models.length === 1 ? '' : 's'} available</span>
              : <span style={{ color: '#ffb4b4', fontSize: 12 }}>{test.error}</span>)}
          </div>
          <div className="label" style={{ marginBottom: 8 }}>Colossus models → server models</div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>Choose which model on your server powers each Colossus model. "Server default" uses the first model the server lists.</div>
          {models.map((m) => (
            <div key={m.id} className="model-row glass-soft">
              <div>
                <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{m.name}</div>
                <div className="label" style={{ fontSize: 9, color: 'var(--accent)', marginTop: 3 }}>{m.tag}</div>
              </div>
              {serverModels.length ? (
                <select className="input mono" style={{ fontSize: 12 }} value={settings.unslothModels?.[m.id] || ''} onChange={(e) => onChange({ unslothModels: { ...settings.unslothModels, [m.id]: e.target.value || undefined } })}>
                  <option value="">Server default{serverModels[0] ? ` (${serverModels[0]})` : ''}</option>
                  {serverModels.map((x) => <option key={x} value={x}>{x}</option>)}
                  {settings.unslothModels?.[m.id] && !serverModels.includes(settings.unslothModels[m.id]) && <option value={settings.unslothModels[m.id]}>{settings.unslothModels[m.id]}</option>}
                </select>
              ) : (
                <input className="input mono" style={{ fontSize: 12 }} placeholder="Server default — or type a model id" defaultValue={settings.unslothModels?.[m.id] || ''} onBlur={(e) => onChange({ unslothModels: { ...settings.unslothModels, [m.id]: e.target.value.trim() || undefined } })} />
              )}
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="field">
            <div className="label" style={{ marginBottom: 8 }}>Anthropic API key</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="password" placeholder={settings.hasApiKey ? '•••••••••••• (saved — paste to replace)' : 'Paste your API key'} value={akey} onChange={(e) => setAkey(e.target.value)} />
              <button className="btn grad" disabled={!akey} onClick={async () => { await onChange({ apiKey: akey }); setAkey(''); }}><KeyRound size={13} /> Save</button>
              {settings.hasApiKey && <button className="btn" onClick={() => onChange({ apiKey: '' })}>Remove</button>}
            </div>
            <div className="hint">{settings.hasApiKey ? <span className="status-ok"><CircleCheck size={13} /> A key is configured</span> : 'Encrypted with Windows secure storage.'}</div>
          </div>
          <div className="field">
            <div className="label" style={{ marginBottom: 8 }}>Custom endpoint (optional)</div>
            <input className="input" placeholder="https://api.anthropic.com" defaultValue={settings.baseURL} onBlur={(e) => onChange({ baseURL: e.target.value.trim() })} />
          </div>
          <div className="label" style={{ marginBottom: 8 }}>Colossus models → backend models</div>
          {models.map((m) => (
            <div key={m.id} className="model-row glass-soft">
              <div>
                <div className="mono" style={{ fontWeight: 600, fontSize: 12.5 }}>{m.name}</div>
                <div className="label" style={{ fontSize: 9, color: 'var(--accent)', marginTop: 3 }}>{m.tag}</div>
              </div>
              <input className="input mono" style={{ fontSize: 12 }} placeholder={m.backend} defaultValue={settings.backendOverrides?.[m.id] || ''} onBlur={(e) => onChange({ backendOverrides: { ...settings.backendOverrides, [m.id]: e.target.value.trim() || undefined } })} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

function UpdateRow() {
  const [u, setU] = useState(null);
  useEffect(() => { api.update.state().then(setU); return api.update.onStatus((x) => setU((p) => ({ ...p, ...x }))); }, []);
  if (!u) return null;
  if (u.status === 'unsupported') {
    return <div className="hint" style={{ maxWidth: 420 }}>{u.reason === 'portable' ? 'This is the portable version, which can’t update itself. Install KSTRL with the Setup installer to get automatic updates.' : 'Automatic updates are available in the installed Windows app.'}</div>;
  }
  const text = {
    idle: 'Updates install automatically.',
    checking: 'Checking for updates…',
    current: 'You’re on the latest version.',
    downloading: `Downloading ${u.version || 'update'}… ${u.percent ?? 0}%`,
    ready: `Version ${u.version} is ready.`,
    error: `Update check failed: ${u.error}`,
  }[u.status] || '';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="hint" style={{ margin: 0 }}>{text}</span>
      {u.status === 'ready'
        ? <button className="btn grad" onClick={() => api.update.install()}>Restart to update</button>
        : <button className="btn" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => api.update.check()}>Check for updates</button>}
    </div>
  );
}

export function SettingsModal({ info, settings, onChange, onClose, initialTab = 'general' }) {
  const [tab, setTab] = useState(initialTab === 'models' ? 'server' : initialTab);
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="modal glass-strong" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2><img src="./logo.png" alt="" /> Settings</h2>
          <button className="icon-btn" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="modal-tabs">
          {[['server', 'Model Server'], ['general', 'General'], ['kestrel', 'Rules'], ['about', 'About']].map(([id, label]) => (
            <button key={id} className={'panel-tab' + (tab === id ? ' active' : '')} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        <div className="modal-body">
          {tab === 'server' && <ServerTab info={info} settings={settings} onChange={onChange} />}
          {tab === 'general' && (
            <>
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
              <UpdateRow />
              <p className="mono" style={{ color: 'var(--text-2)', fontSize: 12, maxWidth: 440, lineHeight: 1.6 }}>
                An AI-native coding environment. Kestrel reads your project, edits files and runs commands — powered by Colossus 2, 2.2 UC, 2.3 and the flagship Colossus 3.
              </p>
              <div className="gold-glass" style={{ borderRadius: 20, padding: 18, width: '100%', maxWidth: 440, textAlign: 'left' }}>
                <div className="mono" style={{ fontWeight: 600, letterSpacing: '.2em', fontSize: 13 }}>KSTRL MAX</div>
                <div className="mono" style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>Everything Kestrel can do, at full effort.</div>
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
