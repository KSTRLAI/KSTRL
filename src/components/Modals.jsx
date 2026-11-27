import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, ExternalLink, LogIn, Eye, EyeOff, KeyRound } from 'lucide-react';
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

// KSTRL's own Sign up / Log in screen (full window). Talks to the KSTRL API directly — no website needed.
export function AuthScreen({ settings, initial = 'login', onClose, onDone }) {
  const [tab, setTab] = useState(initial === 'signup' ? 'signup' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [url, setUrl] = useState('');
  const [needsUrl, setNeedsUrl] = useState(!settings.unslothURL && !settings.builtinServer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [paste, setPaste] = useState(false);
  const [key, setKey] = useState('');
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, [tab, paste]);
  useEffect(() => { const k = (e) => { if (e.key === 'Escape' && !busy) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [busy, onClose]);

  const submit = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setError('');
    if (tab === 'signup' && password.length < 8) { setError('Use a password with at least 8 characters.'); return; }
    setBusy(true);
    const r = await (tab === 'signup' ? api.auth.signup({ name, email, password, url }) : api.auth.signin({ email, password, url }));
    setBusy(false);
    if (!r?.ok) { setError(r?.error || 'Something went wrong'); if (r?.needsUrl) setNeedsUrl(true); if (r?.code === 'email_taken') setTab('login'); return; }
    setPassword('');
    onDone?.(r.account, tab);
    onClose();
  };
  const connectKey = async (e) => {
    e?.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true); setError('');
    const r = await api.server.test({ key: key.trim(), ...(needsUrl ? { url: url.trim() } : {}) });
    if (!r?.ok) { setBusy(false); setError(r?.error || 'Could not connect'); return; }
    await api.settings.update({ provider: 'unsloth', unslothKey: key.trim(), ...(needsUrl ? { unslothURL: r.url || url.trim() } : {}) });
    await api.auth.refresh();
    setBusy(false);
    onDone?.(null, 'key');
    onClose();
  };
  const switchTab = (t) => { setTab(t); setError(''); setPaste(false); };
  const urlField = needsUrl && <label className="af"><span>Server address</span><input className="input mono" placeholder="https://api.example.com" value={url} onChange={(e) => setUrl(e.target.value)} /></label>;

  return (
    <div className="auth-screen">
      <button className="icon-btn auth-close" title="Not now (Esc)" onClick={onClose}><X size={16} /></button>
      <form className="auth-card" onSubmit={paste ? connectKey : submit}>
        <img className="auth-logo" src="./icon.png" alt="" />
        <h2>{paste ? 'Use an API key' : tab === 'signup' ? 'Create your KSTRL account' : 'Welcome back'}</h2>
        <p className="auth-sub">{paste ? 'Paste a key from your KSTRL server.' : tab === 'signup' ? 'Free plan included. Upgrade to MAX any time for 20× more usage.' : 'Log in to sync your plan and usage.'}</p>
        {!paste && (
          <div className="auth-tabs">
            <button type="button" className={tab === 'login' ? 'on' : ''} onClick={() => switchTab('login')}>Log in</button>
            <button type="button" className={tab === 'signup' ? 'on' : ''} onClick={() => switchTab('signup')}>Sign up</button>
          </div>
        )}
        {paste ? (
          <>
            <label className="af"><span>API key</span><input ref={first} className="input mono" type="password" placeholder="sk-…" value={key} onChange={(e) => setKey(e.target.value)} /></label>
            {urlField}
          </>
        ) : (
          <>
            {tab === 'signup' && <label className="af"><span>Name</span><input ref={first} className="input" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} /></label>}
            <label className="af"><span>Email</span><input ref={tab === 'login' ? first : null} className="input" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="af"><span>Password</span>
              <div className="pw">
                <input className="input" type={show ? 'text' : 'password'} autoComplete={tab === 'signup' ? 'new-password' : 'current-password'} placeholder={tab === 'signup' ? 'At least 8 characters' : 'Your password'} value={password} onChange={(e) => setPassword(e.target.value)} />
                <button type="button" className="icon-btn" title={show ? 'Hide' : 'Show'} onClick={() => setShow(!show)}>{show ? <EyeOff size={14} /> : <Eye size={14} />}</button>
              </div>
            </label>
            {urlField}
          </>
        )}
        {error && <div className="auth-err">{error}</div>}
        <button className="btn light auth-go" type="submit" disabled={busy || (paste ? !key.trim() : !email.trim() || !password)}>
          {busy ? <><Loader2 size={14} className="spin" /> {paste ? 'Connecting…' : tab === 'signup' ? 'Creating account…' : 'Logging in…'}</> : paste ? 'Connect' : tab === 'signup' ? 'Create account' : <><LogIn size={14} /> Log in</>}
        </button>
        <div className="auth-foot">
          {paste
            ? <button type="button" className="link" onClick={() => { setPaste(false); setError(''); }}>Back to log in</button>
            : <button type="button" className="link" onClick={() => { setPaste(true); setError(''); }}><KeyRound size={12} /> Use an API key instead</button>}
          <button type="button" className="link" onClick={onClose}>Not now</button>
        </div>
      </form>
    </div>
  );
}
