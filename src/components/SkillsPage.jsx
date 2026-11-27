import React, { useEffect, useState } from 'react';
import { Plus, Sparkles, Pencil, Trash2, MessageSquarePlus, X } from 'lucide-react';

const api = window.kstrl;

// Skills: reusable instructions Kestrel loads when a task matches. Built-in ones plus your own.
export default function SkillsPage({ settings, onChange, onUse }) {
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null); // { id?, name, description, instructions }
  const [q, setQ] = useState('');
  const load = () => api.skills.list().then(setList);
  useEffect(() => { load(); }, [settings.skills, settings.skillsOff]);

  const toggle = (s) => {
    const off = new Set(settings.skillsOff || []);
    if (off.has(s.id)) off.delete(s.id); else off.add(s.id);
    onChange({ skillsOff: [...off] });
  };
  const save = () => {
    if (!edit.name.trim() || !edit.instructions.trim()) return;
    const custom = settings.skills || [];
    const item = { id: edit.id || 'custom-' + Date.now().toString(36), name: edit.name.trim(), description: edit.description.trim(), instructions: edit.instructions };
    onChange({ skills: edit.id ? custom.map((s) => (s.id === edit.id ? item : s)) : [...custom, item] });
    setEdit(null);
  };
  const remove = (s) => { if (confirm(`Delete the skill “${s.name}”?`)) onChange({ skills: (settings.skills || []).filter((x) => x.id !== s.id) }); };

  const shown = list.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase()));
  const group = (title, items) => items.length > 0 && (
    <>
      <div className="sk-group">{title}</div>
      <div className="sk-grid">
        {items.map((s) => (
          <div key={s.id} className={'sk-card' + (s.enabled ? '' : ' off')}>
            <div className="sk-top">
              <Sparkles size={15} />
              <span className="sk-name">{s.name}</span>
              <button className={'switch' + (s.enabled ? ' on' : '')} title={s.enabled ? 'Turn off' : 'Turn on'} onClick={() => toggle(s)}><span /></button>
            </div>
            <div className="sk-desc">{s.description || 'No description'}</div>
            <div className="sk-acts">
              <button className="btn ghost" disabled={!s.enabled} onClick={() => onUse(s)}><MessageSquarePlus size={13} /> Use in chat</button>
              {s.custom
                ? <><button className="icon-btn" title="Edit" onClick={() => setEdit({ ...s })}><Pencil size={13} /></button><button className="icon-btn" title="Delete" onClick={() => remove(s)}><Trash2 size={13} /></button></>
                : <button className="icon-btn" title="Make an editable copy" onClick={() => setEdit({ name: s.name + ' (copy)', description: s.description, instructions: s.instructions })}><Pencil size={13} /></button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="sk-page">
      <div className="sk-head">
        <div>
          <h1>Skills</h1>
          <p>Instructions Kestrel loads when a task matches: how you like tests written, your design style, your deploy steps. Turn them on or off, or make your own.</p>
        </div>
        <button className="btn light" onClick={() => setEdit({ name: '', description: '', instructions: '' })}><Plus size={14} /> New Skill</button>
      </div>
      <input className="input sk-search" placeholder="Search skills" value={q} onChange={(e) => setQ(e.target.value)} />
      {group('Your skills', shown.filter((s) => s.custom))}
      {group('Built-in', shown.filter((s) => s.builtin))}

      {edit && (
        <div className="overlay center" onMouseDown={() => setEdit(null)}>
          <div className="input-dialog sk-edit glass-strong" onMouseDown={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center' }}><h3 style={{ flex: 1 }}>{edit.id ? 'Edit Skill' : 'New Skill'}</h3><button className="icon-btn" onClick={() => setEdit(null)}><X size={15} /></button></div>
            <label className="sk-l">Name</label>
            <input className="input" autoFocus placeholder="e.g. Our API style" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <label className="sk-l">When to use it</label>
            <input className="input" placeholder="e.g. Adding or changing REST endpoints" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            <label className="sk-l">Instructions</label>
            <textarea className="input mono" rows={12} placeholder={'Step-by-step instructions Kestrel follows, e.g.\n- Use Zod to validate request bodies\n- Return errors as { error: { code, message } }\n- Add an integration test for each endpoint'} value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} />
            <div className="row">
              <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn light" disabled={!edit.name.trim() || !edit.instructions.trim()} onClick={save}>Save Skill</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
