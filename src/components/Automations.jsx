import React, { useEffect, useRef, useState } from 'react';
import { Plus, Play, Pencil, Trash2, Bot, Clock, Folder, X, Zap } from 'lucide-react';

const SCHEDULES = [
  ['manual', 'Only when I run it'],
  ['startup', 'When KSTRL starts'],
  ['hourly', 'Every hour'],
  ['daily', 'Every day at…'],
  ['weekdays', 'Weekdays at…'],
];

export function describeSchedule(a) {
  const s = a.schedule || { type: 'manual' };
  if (s.type === 'daily') return `Every day at ${s.time || '09:00'}`;
  if (s.type === 'weekdays') return `Weekdays at ${s.time || '09:00'}`;
  return (SCHEDULES.find(([v]) => v === s.type) || SCHEDULES[0])[1];
}

const base = (p) => (p ? p.split(/[\\/]/).pop() : 'No project');

// Decides which automations are due. Runs every 30s while KSTRL is open.
export function useAutomationScheduler(settings, run) {
  const ref = useRef({ settings, run, started: false });
  ref.current.settings = settings;
  ref.current.run = run;
  useEffect(() => {
    const tick = (startup) => {
      const { settings: s, run: r } = ref.current;
      const now = new Date();
      for (const a of s.automations || []) {
        if (!a.enabled) continue;
        const t = a.schedule?.type || 'manual';
        const last = a.lastRun || 0;
        let due = false;
        if (t === 'startup') due = startup;
        else if (t === 'hourly') due = now - last >= 60 * 60 * 1000;
        else if (t === 'daily' || t === 'weekdays') {
          const [h, m] = (a.schedule.time || '09:00').split(':').map(Number);
          const at = new Date(now); at.setHours(h, m, 0, 0);
          const weekday = now.getDay() >= 1 && now.getDay() <= 5;
          due = now >= at && last < at.getTime() && (t === 'daily' || weekday);
        }
        if (due) r(a, 'schedule');
      }
    };
    const first = setTimeout(() => { if (!ref.current.started) { ref.current.started = true; tick(true); } }, 4000);
    const iv = setInterval(() => tick(false), 30000);
    return () => { clearTimeout(first); clearInterval(iv); };
  }, []);
}

function Editor({ initial, info, settings, onSave, onCancel }) {
  const [a, setA] = useState(initial);
  const up = (patch) => setA((x) => ({ ...x, ...patch }));
  const projects = [...new Set([...(settings.recentFolders || []), ...(a.project ? [a.project] : [])])];
  return (
    <div className="auto-editor glass-strong">
      <div className="auto-ed-head"><span className="label">{initial.name ? 'Edit automation' : 'New automation'}</span><button className="icon-btn" onClick={onCancel}><X size={15} /></button></div>
      <input className="input" autoFocus placeholder="Name, e.g. Morning dependency check" value={a.name} onChange={(e) => up({ name: e.target.value })} />
      <textarea className="input" rows={4} placeholder="What should Kestrel do? e.g. Check for outdated npm packages, update the safe ones, run the tests and summarize what changed." value={a.prompt} onChange={(e) => up({ prompt: e.target.value })} />
      <div className="auto-grid">
        <label><span className="label">Project</span>
          <select className="input" value={a.project || ''} onChange={(e) => up({ project: e.target.value || null })}>
            <option value="">No project</option>
            {projects.map((p) => <option key={p} value={p}>{base(p)}</option>)}
          </select>
        </label>
        <label><span className="label">Schedule</span>
          <select className="input" value={a.schedule.type} onChange={(e) => up({ schedule: { ...a.schedule, type: e.target.value } })}>
            {SCHEDULES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {(a.schedule.type === 'daily' || a.schedule.type === 'weekdays') && (
          <label><span className="label">Time</span><input className="input" type="time" value={a.schedule.time || '09:00'} onChange={(e) => up({ schedule: { ...a.schedule, time: e.target.value } })} /></label>
        )}
        <label><span className="label">Mode</span>
          <select className="input" value={a.mode} onChange={(e) => up({ mode: e.target.value })}><option value="agent">Agent</option><option value="ask">Ask</option></select>
        </label>
        <label><span className="label">Model</span>
          <select className="input" value={a.model} onChange={(e) => up({ model: e.target.value })}>
            <option value="auto">Auto</option>
            {(info?.models || []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </div>
      <div className="auto-note">Scheduled runs happen while KSTRL is open. In Agent mode, commands still ask for approval unless auto-run is on in Settings → Agents.</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn light" disabled={!a.name.trim() || !a.prompt.trim()} onClick={() => onSave({ ...a, name: a.name.trim(), prompt: a.prompt.trim() })}>Save</button>
      </div>
    </div>
  );
}

export default function AutomationsPage({ info, settings, workspace, onChange, onRun }) {
  const list = settings.automations || [];
  const [editing, setEditing] = useState(null);
  const save = (a) => {
    const exists = list.some((x) => x.id === a.id);
    onChange({ automations: exists ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a] });
    setEditing(null);
  };
  const blank = () => ({ id: 'auto-' + Date.now().toString(36), name: '', prompt: '', project: workspace?.root || null, schedule: { type: 'daily', time: '09:00' }, mode: 'agent', model: 'auto', enabled: true, lastRun: 0 });

  return (
    <div className="auto-page">
      <div className="auto-inner">
        <div className="auto-head">
          <div>
            <h1 className="set-title" style={{ margin: 0 }}>Automations</h1>
            <div className="set-note">Let Kestrel do recurring work for you on a schedule.</div>
          </div>
          {!editing && <button className="btn light" onClick={() => setEditing(blank())}><Plus size={14} /> New Automation</button>}
        </div>
        {editing && <Editor initial={editing} info={info} settings={settings} onSave={save} onCancel={() => setEditing(null)} />}
        {list.length === 0 && !editing && (
          <div className="auto-empty glass">
            <Zap size={22} />
            <div className="t">No automations yet</div>
            <div className="d">Examples: a weekday-morning dependency check, an hourly test run, or a startup summary of what changed in the repo.</div>
            <button className="btn light" onClick={() => setEditing(blank())}><Plus size={14} /> Create your first automation</button>
          </div>
        )}
        <div className="auto-list">
          {list.map((a) => (
            <div key={a.id} className={'auto-card glass' + (a.enabled ? '' : ' off')}>
              <div className="auto-ic"><Bot size={16} /></div>
              <div className="auto-body">
                <div className="t">{a.name}</div>
                <div className="d">{a.prompt}</div>
                <div className="meta">
                  <span><Clock size={11} /> {describeSchedule(a)}</span>
                  <span><Folder size={11} /> {base(a.project)}</span>
                  <span>{a.mode === 'ask' ? 'Ask' : 'Agent'} · {a.model === 'auto' ? 'Auto' : (info?.models || []).find((m) => m.id === a.model)?.name}</span>
                  {a.lastRun ? <span>Last run {new Date(a.lastRun).toLocaleString()}</span> : null}
                </div>
              </div>
              <div className="auto-actions">
                <button className={'toggle' + (a.enabled ? ' on' : '')} title={a.enabled ? 'Enabled' : 'Paused'} onClick={() => onChange({ automations: list.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)) })} />
                <button className="icon-btn" title="Run now" onClick={() => onRun(a, 'manual')}><Play size={14} /></button>
                <button className="icon-btn" title="Edit" onClick={() => setEditing(a)}><Pencil size={13} /></button>
                <button className="icon-btn" title="Delete" onClick={() => { if (confirm(`Delete “${a.name}”?`)) onChange({ automations: list.filter((x) => x.id !== a.id) }); }}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
