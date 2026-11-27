import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, ExternalLink, LogIn } from 'lucide-react';
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

const KEY_SITE = 'https://kstrlsi.base44.app/';

// Log in through the website (kstrl:// link back into the app), or paste an API key as a fallback.
// Asks for the API URL only when the build doesn't include one.
export function ConnectApiDialog({ settings, waiting: startWaiting, onClose, onConnected }) {
  const needsUrl = !settings.usingBuiltinServer && !settings.builtinServer;
  const [waiting, setWaiting] = useState(!!startWaiting);
  const [paste, setPaste] = useState(false);
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(settings.unslothURL || '');
  const [state, setState] = useState(null); // null | 'testing' | { error }
  const was = useRef(settings.loggedIn);
  useEffect(() => { if (settings.loggedIn && !was.current) { onConnected?.(settings); onClose(); } was.current = settings.loggedIn; }, [settings.loggedIn]); // eslint-disable-line

  const login = () => { api.auth.login(); setWaiting(true); };
  const connect = async () => {
    if (!key.trim() || (needsUrl && !url.trim()) || state === 'testing') return;
    setState('testing');
    const r = await api.server.test({ key: key.trim(), ...(needsUrl ? { url: url.trim() } : {}) });
    if (!r?.ok) { setState({ error: r?.error || 'Could not connect' }); return; }
    const next = await api.settings.update({ provider: 'unsloth', unslothKey: key.trim(), ...(needsUrl ? { unslothURL: r.url || url.trim() } : {}) });
    api.auth.refresh();
    onConnected?.(next);
    onClose();
  };
  const onKey = (e) => { if (e.key === 'Enter') connect(); if (e.key === 'Escape') onClose(); };
  return (
    <div className="overlay center" onMouseDown={onClose}>
      <div className="input-dialog connect-dialog glass-strong" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Log in to KSTRL</h3>
        <p>Use your kstrlsi account. If you're already logged in on the website, it only takes a click.</p>
        <button className="btn light login-btn" onClick={login}>{waiting ? <><Loader2 size={14} className="spin" /> Waiting for your browser…</> : <><LogIn size={14} /> Log in with kstrlsi</>}</button>
        {waiting && <div className="login-wait">Finish in the browser window that just opened — KSTRL connects by itself. <button className="link" onClick={login}>Open it again</button></div>}
        {!paste ? (
          <button className="link paste-toggle" onClick={() => setPaste(true)}>Or paste an API key instead</button>
        ) : (
          <div className="cstep col">
            <div className="cstep-row"><span className="t">API key</span><button className="link" onClick={() => api.shell.openExternal(KEY_SITE)}>Get one on kstrlsi <ExternalLink size={11} /></button></div>
            <input className="input mono" type="password" autoFocus placeholder="Paste your API key" value={key} onChange={(e) => { setKey(e.target.value); setState(null); }} onKeyDown={onKey} />
            {needsUrl && <input className="input mono" placeholder="API URL, e.g. https://api.example.com" value={url} onChange={(e) => { setUrl(e.target.value); setState(null); }} onKeyDown={onKey} />}
            {state?.error && <div className="cerr">{state.error}</div>}
            <div className="row" style={{ marginTop: 4 }}>
              <button className="btn light" disabled={!key.trim() || (needsUrl && !url.trim()) || state === 'testing'} onClick={connect}>
                {state === 'testing' ? <><Loader2 size={13} className="spin" /> Connecting…</> : 'Connect'}
              </button>
            </div>
          </div>
        )}
        <div className="row"><button className="btn ghost" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
