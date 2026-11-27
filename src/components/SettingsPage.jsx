import React, { useEffect, useMemo, useState } from 'react';
import { fmtKbd, mod } from '../lib/keys.js';
import {
  ArrowLeft, Search, Settings as Gear, Palette, CreditCard, Bot, Boxes, Keyboard, Info, BookOpen, ArrowUpRight, ExternalLink,
  Server, Cloud, PlugZap, Loader2, CircleCheck, KeyRound, Check, Minus, Plus, Zap, Code2, Brain, Sparkles, ArrowUpCircle, RotateCcw,
} from 'lucide-react';

const api = window.kstrl;
const SITE = 'https://kstrlsi.base44.app/';

const NAV = [
  { id: 'general', label: 'General', I: Gear },
  { id: 'appearance', label: 'Appearance', I: Palette },
  { id: 'plan', label: 'Plan & Usage', I: CreditCard },
  { id: 'agents', label: 'Agents', I: Bot },
  { id: 'models', label: 'Models', I: Boxes },
  { id: 'keys', label: 'Keyboard Shortcuts', I: Keyboard },
  { id: 'about', label: 'About', I: Info },
  { id: 'docs', label: 'Docs', I: BookOpen, external: SITE },
];
const TAG_ICON = { Fast: Zap, Ultracode: Code2, Reasoning: Brain, Flagship: Sparkles };

function Toggle({ on, onChange }) {
  return <button className={'toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;
}
function Select({ value, options, onChange }) {
  return (
    <select className="input set-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
function Stepper({ value, min, max, onChange, suffix = '' }) {
  return (
    <div className="stepper">
      <button className="icon-btn" onClick={() => onChange(Math.max(min, value - 1))}><Minus size={13} /></button>
      <span className="mono">{value}{suffix}</span>
      <button className="icon-btn" onClick={() => onChange(Math.min(max, value + 1))}><Plus size={13} /></button>
    </div>
  );
}

function UpdateControl() {
  const [u, setU] = useState(null);
  useEffect(() => { api.update.state().then(setU); return api.update.onStatus((x) => setU((p) => ({ ...p, ...x }))); }, []);
  if (!u) return null;
  if (u.status === 'unsupported') return <span className="set-note">{u.reason === 'portable' ? 'Portable version — install with KSTRL-Setup to update automatically' : 'Available in the installed app'}</span>;
  if (u.status === 'ready') return <button className="btn grad" onClick={() => api.update.install()}><ArrowUpCircle size={13} /> Restart to update</button>;
  if (u.status === 'available') return <button className="btn light" onClick={() => api.update.download()}>Download {u.version}</button>;
  const note = { checking: 'Checking…', current: 'Up to date', downloading: `Downloading… ${u.percent ?? 0}%`, error: 'Check failed' }[u.status];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {note && <span className="set-note">{note}</span>}
      <button className="btn" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => api.update.check()}>Check now</button>
    </div>
  );
}

function ServerSettings({ info, settings, onChange }) {
  const provider = ['anthropic', 'grok'].includes(settings.provider) ? settings.provider : 'unsloth';
  const [gkey, setGkey] = useState('');
  const [url, setUrl] = useState(settings.unslothURL || '');
  const [key, setKey] = useState('');
  const [akey, setAkey] = useState('');
  const [test, setTest] = useState(null);
  const models = info?.models || [];

  const runTest = async () => {
    setTest({ busy: true });
    await onChange({ unslothURL: url.trim(), ...(key ? { unslothKey: key } : {}) });
    setKey('');
    setTest(await api.server.test({}));
  };
  useEffect(() => { setTest(null); if ((provider === 'unsloth' && (settings.unslothURL || settings.usingBuiltinServer)) || (provider === 'grok' && settings.hasGrokKey)) api.server.test({}).then(setTest); }, [provider]); // eslint-disable-line
  const serverModels = test?.ok ? test.models : [];

  return (
    <div className="set-card">
      <div className="set-row">
        <div className="set-txt stack"><div className="t">Model server</div><div className="d">Where the Colossus models run.</div></div>
        <div className="seg sm">
          <button className={provider === 'unsloth' ? 'on' : ''} onClick={() => onChange({ provider: 'unsloth' })}><Server size={13} /> OpenAI-compatible</button>
          <button className={provider === 'grok' ? 'on' : ''} onClick={() => onChange({ provider: 'grok' })}><Zap size={13} /> Grok</button>
          <button className={provider === 'anthropic' ? 'on' : ''} onClick={() => onChange({ provider: 'anthropic' })}><Cloud size={13} /> Anthropic</button>
        </div>
      </div>
      {provider === 'grok' ? (
        <>
          <div className="set-row col">
            <div className="set-txt stack"><div className="t">xAI API key</div><div className="d">{settings.hasGrokKey ? <span className="status-ok"><CircleCheck size={13} /> A key is configured</span> : <>Get one at <button className="link" onClick={() => api.shell.openExternal('https://console.x.ai')}>console.x.ai</button>. Stored encrypted on this PC; Kestrel talks to api.x.ai directly.</>}</div></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="password" placeholder={settings.hasGrokKey ? '•••••••••••• (saved — paste to replace)' : 'xai-…'} value={gkey} onChange={(e) => setGkey(e.target.value)} />
              <button className="btn light" disabled={!gkey.trim()} onClick={async () => { await onChange({ grokKey: gkey.trim() }); setGkey(''); setTest({ busy: true }); setTest(await api.server.test({})); }}><KeyRound size={13} /> Save</button>
              {settings.hasGrokKey && <button className="btn" onClick={() => { onChange({ grokKey: '' }); setTest(null); }}>Remove</button>}
            </div>
          </div>
          <div className="set-row">
            <div className="set-txt">{test && !test.busy ? (test.ok ? <span className="status-ok"><CircleCheck size={13} /> Connected to xAI · {test.models.length} models</span> : <span className="set-error">{test.error}</span>) : <div className="d">Save a key to load the Grok models.</div>}</div>
            <button className="btn light" disabled={!settings.hasGrokKey || test?.busy} onClick={async () => { setTest({ busy: true }); setTest(await api.server.test({})); }}>{test?.busy ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Test connection</button>
          </div>
          {models.map((m) => (
            <div key={m.id} className="set-row">
              <div className="set-txt stack"><div className="t">{m.name}</div><div className="d">{m.hidden ? 'Grok model used when effort is set to UltraCode' : `Grok model for ${m.name}`}</div></div>
              {serverModels.length ? (
                <select className="input set-select mono" value={settings.grokModels?.[m.id] || ''} onChange={(e) => onChange({ grokModels: { ...settings.grokModels, [m.id]: e.target.value || undefined } })}>
                  <option value="">Default ({settings.grokDefault})</option>
                  {serverModels.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <input className="input set-select mono" placeholder={settings.grokDefault} defaultValue={settings.grokModels?.[m.id] || ''} onBlur={(e) => onChange({ grokModels: { ...settings.grokModels, [m.id]: e.target.value.trim() || undefined } })} />
              )}
            </div>
          ))}
        </>
      ) : provider === 'unsloth' ? (
        <>
          {settings.usingBuiltinServer && <div className="set-row"><div className="set-txt stack"><div className="t">Built-in server</div><div className="d">This copy of KSTRL came pre-connected. Enter a URL below to use your own server instead.</div></div><span className="status-ok"><CircleCheck size={13} /> Active</span></div>}
          <div className="set-row col">
            <div className="set-txt stack"><div className="t">Server URL</div><div className="d">Any OpenAI-compatible endpoint: Launch, Unsloth, vLLM, LM Studio, Ollama, OpenRouter… "/v1" is added automatically.</div></div>
            <input className="input mono" placeholder="http://127.0.0.1:8000" value={url} onChange={(e) => setUrl(e.target.value)} onBlur={() => url.trim() !== (settings.unslothURL || '') && onChange({ unslothURL: url.trim() })} onKeyDown={(e) => e.key === 'Enter' && runTest()} />
          </div>
          <div className="set-row col">
            <div className="set-txt stack"><div className="t">API key <span className="opt-l">optional</span></div><div className="d">Stored encrypted on this PC.</div></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="password" placeholder={settings.hasUnslothKey ? '•••••••••••• (saved — paste to replace)' : 'Only if your server requires one'} value={key} onChange={(e) => setKey(e.target.value)} />
              {settings.hasUnslothKey && <button className="btn" onClick={() => onChange({ unslothKey: '' })}>Remove</button>}
            </div>
          </div>
          <div className="set-row">
            <div className="set-txt">
              {test && !test.busy ? (test.ok ? <span className="status-ok"><CircleCheck size={13} /> Connected · {test.models.length} model{test.models.length === 1 ? '' : 's'} on the server</span> : <span className="set-error">{test.error}</span>) : <div className="d">Test the connection to load the server's models.</div>}
            </div>
            <button className="btn light" disabled={!(url.trim() || settings.usingBuiltinServer) || test?.busy} onClick={runTest}>{test?.busy ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />} Test connection</button>
          </div>
          {models.map((m) => (
            <div key={m.id} className="set-row">
              <div className="set-txt stack"><div className="t">{m.name}</div><div className="d">{m.hidden ? 'Server model used when effort is set to UltraCode' : `Server model for ${m.name}`}</div></div>
              {serverModels.length ? (
                <select className="input set-select mono" value={settings.unslothModels?.[m.id] || ''} onChange={(e) => onChange({ unslothModels: { ...settings.unslothModels, [m.id]: e.target.value || undefined } })}>
                  <option value="">Server default{serverModels[0] ? ` (${serverModels[0]})` : ''}</option>
                  {serverModels.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              ) : (
                <input className="input set-select mono" placeholder="Server default" defaultValue={settings.unslothModels?.[m.id] || ''} onBlur={(e) => onChange({ unslothModels: { ...settings.unslothModels, [m.id]: e.target.value.trim() || undefined } })} />
              )}
            </div>
          ))}
        </>
      ) : (
        <>
          <div className="set-row col">
            <div className="set-txt stack"><div className="t">Anthropic API key</div><div className="d">{settings.hasApiKey ? <span className="status-ok"><CircleCheck size={13} /> A key is configured</span> : 'Stored encrypted on this PC.'}</div></div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="password" placeholder={settings.hasApiKey ? '•••••••••••• (saved — paste to replace)' : 'Paste your API key'} value={akey} onChange={(e) => setAkey(e.target.value)} />
              <button className="btn light" disabled={!akey} onClick={async () => { await onChange({ apiKey: akey }); setAkey(''); }}><KeyRound size={13} /> Save</button>
              {settings.hasApiKey && <button className="btn" onClick={() => onChange({ apiKey: '' })}>Remove</button>}
            </div>
          </div>
          <div className="set-row col">
            <div className="set-txt stack"><div className="t">Custom endpoint <span className="opt-l">optional</span></div></div>
            <input className="input" placeholder="https://api.anthropic.com" defaultValue={settings.baseURL} onBlur={(e) => onChange({ baseURL: e.target.value.trim() })} />
          </div>
          {models.map((m) => (
            <div key={m.id} className="set-row">
              <div className="set-txt stack"><div className="t">{m.name}</div><div className="d">{m.hidden ? 'Backend model for UltraCode effort' : 'Backend model'}</div></div>
              <input className="input set-select mono" placeholder={m.backend} defaultValue={settings.backendOverrides?.[m.id] || ''} onBlur={(e) => onChange({ backendOverrides: { ...settings.backendOverrides, [m.id]: e.target.value.trim() || undefined } })} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n || 0));

export default function SettingsPage({ info, settings, onChange, onBack, initialTab = 'general', commands = [], onLogin, onProjectRules }) {
  const [tab, setTab] = useState(initialTab === 'server' ? 'models' : initialTab === 'kestrel' ? 'agents' : initialTab);
  const [q, setQ] = useState('');
  const models = info?.models || [];
  const set = (k) => (v) => onChange({ [k]: v });
  const pickable = models.filter((m) => !m.hidden);
  const enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((id) => pickable.some((m) => m.id === id)) : pickable.map((m) => m.id);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && !e.target.closest?.('input,textarea,select')) onBack(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onBack]);

  // Data-driven sections so search can find any row.
  const sections = [
    { tab: 'general', title: null, rows: [
      { t: 'Account', d: settings.loggedIn ? [settings.account?.email, settings.account?.name].filter(Boolean).join(' · ') || 'Logged in' : settings.account?.expired ? 'Your login expired' : 'Not logged in', c: settings.loggedIn
        ? <button className="btn" onClick={() => api.auth.logout()}>Log Out</button>
        : <button className="btn light" onClick={() => onLogin?.()}>Log In</button> },
      { t: 'Plan', d: settings.usageToday?.plan === 'max' ? 'KSTRL MAX' : 'KSTRL Free', c: <button className="btn" onClick={() => setTab('plan')}>Manage</button> },
      { t: 'Upgrade to KSTRL MAX', d: '20× the daily usage of Free, Max effort on every model and early access to new models.', c: <button className="btn grad" onClick={() => api.shell.openExternal(SITE)}><ArrowUpCircle size={13} /> Upgrade</button> },
    ] },
    { tab: 'general', title: 'Startup', rows: [
      { t: 'Tips', d: 'Show rotating tips on the empty screen', c: <Toggle on={settings.showTips !== false} onChange={set('showTips')} /> },
      { t: 'Reopen last project', d: 'Open the project you were last working on when KSTRL starts', c: <Toggle on={settings.reopenLastProject !== false} onChange={set('reopenLastProject')} /> },
    ] },
    { tab: 'general', title: 'Notifications', rows: [
      { t: 'System Notifications', d: 'Show a Windows notification when Kestrel finishes or needs approval while KSTRL is in the background', c: <Toggle on={settings.systemNotifications !== false} onChange={set('systemNotifications')} /> },
      { t: 'Completion Sound', d: 'Play a sound when Kestrel finishes or needs attention', c: <Toggle on={!!settings.completionSound} onChange={set('completionSound')} /> },
      { t: 'System Tray Icon', d: 'Show KSTRL in the system tray', c: <Toggle on={!!settings.trayIcon} onChange={set('trayIcon')} /> },
    ] },
    { tab: 'general', title: 'Updates', rows: [
      { t: 'Send Crash Reports', d: 'When something breaks, send the error (no code or chats) to KSTRL so it can be fixed', c: <Toggle on={!!settings.crashReports} onChange={set('crashReports')} /> },
      { t: 'Logs', d: 'Error log for troubleshooting', c: <button className="btn" onClick={() => api.log.openFolder()}>Open Logs Folder</button> },
      { t: 'Automatic Updates', d: 'Download new versions of KSTRL in the background and install them on restart', c: <Toggle on={settings.autoUpdate !== false} onChange={set('autoUpdate')} /> },
      { t: `Version ${info?.version || ''}`, d: 'Check GitHub for a newer release', c: <UpdateControl /> },
    ] },

    { tab: 'appearance', title: 'Window', rows: [
      { t: 'Reduce Transparency', d: 'Turn off the glass blur effects (faster on older PCs)', c: <Toggle on={!!settings.reduceTransparency} onChange={set('reduceTransparency')} /> },
      { t: 'Interface Scale', d: 'Size of the whole interface', c: <Select value={String(settings.uiScale || 100)} options={[['90', '90%'], ['100', '100%'], ['110', '110%'], ['125', '125%']]} onChange={(v) => onChange({ uiScale: Number(v) })} /> },
    ] },
    { tab: 'appearance', title: 'Editor', rows: [
      { t: 'Font Size', d: 'Code editor font size (Ctrl+= / Ctrl+-)', c: <Stepper value={settings.fontSize || 14} min={10} max={28} onChange={set('fontSize')} /> },
      { t: 'Tab Autocomplete', d: 'Grey suggestions as you type, accepted with Tab. Uses Colossus 2.1 and a small amount of usage.', c: <Toggle on={settings.tabAutocomplete !== false} onChange={set('tabAutocomplete')} /> },
      { t: 'Minimap', d: 'Show the code overview on the right of the editor', c: <Toggle on={settings.minimap !== false} onChange={set('minimap')} /> },
      { t: 'Word Wrap', d: 'Wrap long lines in the editor', c: <Toggle on={!!settings.wordWrap} onChange={set('wordWrap')} /> },
    ] },

    { tab: 'plan', title: null, custom: 'plan', rows: [{ t: 'Plan KSTRL Free MAX upgrade', d: '' }] },
    { tab: 'plan', title: 'Today', custom: 'daily', rows: [{ t: 'Daily usage limit resets midnight credits', d: '' }] },
    { tab: 'plan', title: 'What uses more', custom: 'costs', rows: [{ t: 'Usage cost Build Plan Ask models', d: '' }] },
    { tab: 'plan', title: 'All-time usage on this PC', custom: 'usage', rows: [{ t: 'Usage requests tokens', d: '' }] },

    { tab: 'agents', title: 'Defaults', rows: [
      { t: 'Default Mode', d: 'Build edits files and runs commands; Plan brainstorms on Colossus 2.1; Ask only reads and answers', c: <Select value={settings.mode || 'build'} options={(info?.modes || []).map((m) => [m.id, m.name])} onChange={set('mode')} /> },
      { t: 'Default Effort', d: 'How hard Kestrel works on each request', c: <Select value={settings.effort || 'normal'} options={(info?.efforts || []).map((e) => [e.id, e.name])} onChange={set('effort')} /> },
      { t: 'Max Steps per Request', d: 'Kestrel stops after this many model turns in one request', c: <Stepper value={settings.maxSteps || 60} min={5} max={500} onChange={set('maxSteps')} /> },
      { t: 'Context Window', d: 'Long tasks are compacted (old tool output trimmed, earlier work summarised) so every request fits in this many tokens', c: <Select value={String(settings.contextWindow ?? 12000)} options={[['8000', '8k'], ['12000', '12k'], ['16000', '16k'], ['32000', '32k'], ['64000', '64k'], ['128000', '128k'], ['0', 'Off']]} onChange={(v) => set('contextWindow')(Number(v))} /> },
    ] },
    { tab: 'agents', title: 'Safety', rows: [
      { t: 'Auto-run Commands', d: 'Let Kestrel run terminal commands without asking first. Off by default.', c: <Toggle on={!!settings.autoRunCommands} onChange={set('autoRunCommands')} /> },
      { t: 'Web Access', d: 'Let Kestrel search the web and read pages (docs, error messages)', c: <Select value={settings.webAccess || 'ask'} options={[['ask', 'Ask each time'], ['allow', 'Always allow'], ['off', 'Off']]} onChange={set('webAccess')} /> },
    ] },
    { tab: 'agents', title: 'Rules', rows: [
      { t: 'Project Rules', d: 'Instructions for the open project, saved in .kstrl/rules.md and followed in every chat. Commit it to share with your team.', c: <button className="btn" onClick={() => onProjectRules?.()}>Edit Project Rules</button> },
      { t: 'Rules for Kestrel', d: 'Added to every conversation in Build, Plan and Ask mode', full: true, c: <textarea className="input" rows={6} placeholder={'e.g.\n- Use TypeScript and functional React components\n- Prefer pnpm\n- Write tests with Vitest'} defaultValue={settings.customInstructions} onBlur={(e) => onChange({ customInstructions: e.target.value })} /> },
    ] },

    { tab: 'models', title: 'Model Picker', rows: pickable.map((m) => {
      const I = TAG_ICON[m.tag] || Sparkles;
      const on = enabled.includes(m.id);
      return { t: m.name, d: m.description, icon: <I size={14} />, c: <Toggle on={on} onChange={(v) => { const next = v ? [...new Set([...enabled, m.id])] : enabled.filter((x) => x !== m.id); if (next.length) onChange({ enabledModels: next }); }} /> };
    }) },
    { tab: 'models', title: 'Model Server', custom: 'server', rows: [{ t: 'Model server OpenAI-compatible endpoint URL API key Grok xAI Anthropic connection', d: '' }] },

    { tab: 'keys', title: null, rows: commands.filter((c) => c.kbd).map((c) => ({ t: c.label, d: '', c: <span className="kbd-chip mono">{fmtKbd(c.kbd)}</span> })) },
  ];

  const query = q.trim().toLowerCase();
  const visible = query
    ? sections.map((s) => ({ ...s, rows: s.rows.filter((r) => `${r.t} ${r.d} ${s.title || ''}`.toLowerCase().includes(query)) })).filter((s) => s.rows.length)
    : sections.filter((s) => s.tab === tab);

  const usageRows = models.map((m) => ({ m, u: settings.usage?.[m.id] || { requests: 0, inputTokens: 0, outputTokens: 0 } }));
  const totals = usageRows.reduce((a, { u }) => ({ requests: a.requests + u.requests, inputTokens: a.inputTokens + u.inputTokens, outputTokens: a.outputTokens + u.outputTokens }), { requests: 0, inputTokens: 0, outputTokens: 0 });

  const renderCustom = (s) => {
    if (s.custom === 'server') return <ServerSettings info={info} settings={settings} onChange={onChange} />;
    if (s.custom === 'plan') return (
      <div className="plan-grid">
        <div className="set-card plan">
          <div className="label">Current plan</div>
          <div className="plan-name">{settings.usageToday?.plan === 'max' ? 'KSTRL MAX' : 'KSTRL Free'}</div>
          <div className="set-note">{settings.usageToday?.plan === 'max' ? '20× the daily usage of Free.' : `${fmt(info?.plans?.free?.daily || 0)} credits a day. Resets at midnight.`}</div>
        </div>
        <div className="gold-glass plan">
          <div className="gt">KSTRL MAX</div>
          <div className="gs">Everything Kestrel can do, at full effort.</div>
          <ul>{['20× the daily usage of Free', 'Max effort on every model', 'Early access to new models'].map((t) => <li key={t}><Check size={12} /> {t}</li>)}</ul>
          <button className="btn black" style={{ width: '100%' }} onClick={() => api.shell.openExternal(SITE)}><ArrowUpCircle size={13} /> Upgrade</button>
        </div>
      </div>
    );
    if (s.custom === 'daily') {
      const u = settings.usageToday || { used: 0, limit: 1, percent: 0, left: 1, resetsAt: Date.now(), byMode: {} };
      const at = new Date(u.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return (
        <div className="set-card" style={{ padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{Math.round(u.percent)}% used</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{u.planName || 'Free'} · {fmt(Math.round(Math.min(u.used, u.limit)))} / {fmt(u.limit)} credits</div>
          </div>
          <div className={'usage-meter' + (u.percent >= 85 ? ' low' : '')}><span style={{ width: `${u.percent}%` }} /></div>
          <div className="usage-meta">
            <span>{u.left > 0 ? `Resets at ${at}` : `Out of usage — chat is back at ${at}`}</span>
            <span>{(info?.modes || []).map((m) => `${m.name} ${fmt(Math.round(u.byMode?.[m.id] || 0))}`).join(' · ')}</span>
          </div>
        </div>
      );
    }
    if (s.custom === 'costs') {
      const w = (x) => `${x}×`;
      return (
        <div className="set-card" style={{ padding: '12px 16px 14px' }}>
          <div className="set-note" style={{ margin: 0 }}>Each request uses credits based on its length. Build uses the most; Plan and Ask use much less. Bigger models use more.</div>
          <div className="cost-grid">
            {(info?.modes || []).map((m) => <div key={m.id} className="c"><div className="n">{m.name} mode</div><div className="v">{w(m.weight)} {m.id === 'plan' ? '· on Colossus 2.1' : ''}</div></div>)}
          </div>
          <div className="cost-grid">
            {models.filter((m) => m.weight).map((m) => <div key={m.id} className="c"><div className="n">{m.hidden ? 'UltraCode' : m.name}</div><div className="v">{w(m.weight)}</div></div>)}
          </div>
        </div>
      );
    }
    if (s.custom === 'usage') return (
      <div className="set-card">
        <div className="usage-row head"><span>Model</span><span>Requests</span><span>Input tokens</span><span>Output tokens</span></div>
        {usageRows.map(({ m, u }) => (
          <div key={m.id} className="usage-row"><span>{m.hidden ? 'UltraCode' : m.name}</span><span>{fmt(u.requests)}</span><span>{fmt(u.inputTokens)}</span><span>{fmt(u.outputTokens)}</span></div>
        ))}
        <div className="usage-row total"><span>Total</span><span>{fmt(totals.requests)}</span><span>{fmt(totals.inputTokens)}</span><span>{fmt(totals.outputTokens)}</span></div>
        <div className="set-row"><div className="set-txt stack"><div className="d">Counted on this PC from what your model server reports.</div></div><button className="btn" onClick={() => onChange({ usage: {} })}><RotateCcw size={12} /> Reset</button></div>
      </div>
    );
    return null;
  };

  return (
    <div className="settings-page">
      <aside className="set-nav glass-pane">
        <button className="set-back" onClick={onBack}><ArrowLeft size={15} /> Back</button>
        <div className="set-search">
          <Search size={14} />
          <input placeholder="Search Settings" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={'set-nav-item' + (!query && tab === n.id ? ' active' : '')} onClick={() => (n.external ? api.shell.openExternal(n.external) : (setTab(n.id), setQ('')))}>
              <n.I size={16} /> {n.label} {n.external && <ArrowUpRight size={13} className="ext" />}
            </button>
          ))}
        </nav>
      </aside>
      <main className="set-main">
        <div className="set-inner">
          {!query && tab === 'general' && !settings.configured && (
            <div className="set-banner glass">
              <div><div className="t">Connect your model server</div><div className="d">Log in, or connect an OpenAI-compatible server or Grok, to run the Colossus models.</div></div>
              <button className="btn" onClick={() => setTab('models')}>Open Models</button>
            </div>
          )}
          <h1 className="set-title">{query ? `Results for “${q}”` : NAV.find((n) => n.id === tab)?.label}</h1>
          {visible.length === 0 && <div className="set-note">No settings match.</div>}
          {visible.map((s, i) => (
            <section key={i} className="set-section">
              {(s.title || query) && <div className="set-sec-title">{query ? `${NAV.find((n) => n.id === s.tab)?.label}${s.title ? ' · ' + s.title : ''}` : s.title}</div>}
              {s.custom && !query ? renderCustom(s) : s.custom ? (
                <div className="set-card"><div className="set-row"><div className="set-txt stack"><div className="t">{s.title || 'Plan'}</div></div><button className="btn" onClick={() => { setTab(s.tab); setQ(''); }}>Open</button></div></div>
              ) : (
                <div className="set-card">
                  {s.rows.map((r, j) => (
                    <div key={j} className={'set-row' + (r.full ? ' col' : '')}>
                      <div className="set-txt">{r.icon && <span className="row-ic">{r.icon}</span>}<div><div className="t">{r.t}</div>{r.d && <div className="d">{r.d}</div>}</div></div>
                      {r.c}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
          {!query && tab === 'about' && (
            <div className="set-card about">
              <img src="./icon.png" alt="" />
              <div className="mono" style={{ letterSpacing: '.4em', fontSize: 18, paddingLeft: '.4em' }}>KSTRL</div>
              <div className="set-note">Version {info?.version} · {info?.platform === 'win32' ? 'Windows' : info?.platform}</div>
              <p>An AI-native coding environment. Kestrel reads your project, edits files and runs commands — powered by the Colossus models — Colossus 2.1, 2.2 and the flagship Colossus 3.</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <UpdateControl />
                <button className="btn" onClick={() => api.shell.openExternal(SITE)}>kstrlsi <ExternalLink size={12} /></button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
