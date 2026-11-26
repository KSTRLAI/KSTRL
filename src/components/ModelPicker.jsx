import React, { useEffect, useState } from 'react';
import { Check, ChevronRight, ChevronLeft, Info, Wand2, SlidersHorizontal } from 'lucide-react';

// Flagship first, like the reference dropdown.
const ORDER = ['colossus-3', 'colossus-2.1', 'colossus-2'];
const NOTE = { 'colossus-3': 'Flagship' };

export const enabledModels = (info, settings) => {
  const all = (info?.models || []).filter((m) => !m.hidden).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const on = settings.enabledModels;
  const list = Array.isArray(on) ? all.filter((m) => on.includes(m.id)) : all;
  return list.length ? list : all;
};

// Picks the model for a request: UltraCode effort → Colossus 2.2 UC; "Auto" → by task size.
export function resolveModel(info, settings, { text = '', contextCount = 0, mode } = {}) {
  if (settings.effort === 'ultracode') {
    const uc = (info?.models || []).find((m) => m.id === 'colossus-2.2-uc');
    if (uc) return { model: uc, auto: false };
  }
  const list = enabledModels(info, settings);
  if (settings.model !== 'auto') return { model: list.find((m) => m.id === settings.model) || list[0], auto: false };
  const pick = (...ids) => ids.map((id) => list.find((m) => m.id === id)).find(Boolean) || list[0];
  const effort = settings.effort;
  let m;
  if (effort === 'max' || effort === 'high' || contextCount > 1 || text.length >= 600) m = pick('colossus-3', 'colossus-2.1', 'colossus-2');
  else if (mode === 'agent' || contextCount > 0 || text.length >= 220) m = pick('colossus-2.1', 'colossus-3', 'colossus-2');
  else m = pick('colossus-2', 'colossus-2.1', 'colossus-3');
  return { model: m, auto: true };
}

export function modelLabel(info, settings) {
  if (settings.effort === 'ultracode') return 'Colossus 2.2 UC';
  if (settings.model === 'auto') return 'Auto';
  return (info?.models || []).find((m) => m.id === settings.model)?.name || 'Model';
}

export function ModelMenu({ info, settings, onSettings, onClose, onManage }) {
  const [view, setView] = useState('models'); // models | effort | more
  const list = enabledModels(info, settings);
  const efforts = info?.efforts || [];
  const effort = efforts.find((e) => e.id === settings.effort) || efforts[1];
  const uc = settings.effort === 'ultracode';

  const choose = (m) => { onSettings({ model: m.id, ...(uc ? { effort: 'normal' } : {}) }); onClose(); };

  // Number keys pick a model, like the reference.
  useEffect(() => {
    const onKey = (e) => {
      if (view !== 'models' || e.ctrlKey || e.altKey || e.metaKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= list.length) { e.preventDefault(); choose(list[n - 1]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (view === 'effort') return (
    <div className="mmenu">
      <button className="mm-back" onClick={() => setView('models')}><ChevronLeft size={15} /> Effort</button>
      <div className="mm-sep" />
      {efforts.map((e) => (
        <button key={e.id} className="mm-item" onClick={() => { onSettings({ effort: e.id }); onClose(); }} title={e.description}>
          <span className="nm">{e.name}</span>
          <span className="desc">{e.description}</span>
          {e.id === effort?.id ? <Check size={16} className="ck" /> : <span className="num" />}
        </button>
      ))}
    </div>
  );

  if (view === 'more') return (
    <div className="mmenu">
      <button className="mm-back" onClick={() => setView('models')}><ChevronLeft size={15} /> More models</button>
      <div className="mm-sep" />
      <button className="mm-item" onClick={() => { onSettings({ model: 'auto', ...(uc ? { effort: 'normal' } : {}) }); onClose(); }}>
        <Wand2 size={15} className="lead" />
        <span className="nm">Auto</span>
        <span className="desc">Picks a Colossus model for each request</span>
        {settings.model === 'auto' && !uc ? <Check size={16} className="ck" /> : <span className="num" />}
      </button>
      <button className="mm-item" onClick={() => { onSettings({ effort: 'ultracode' }); onClose(); }}>
        <span className="lead-txt">UC</span>
        <span className="nm">Colossus 2.2 UC</span>
        <span className="desc">Turns on UltraCode effort</span>
        {uc ? <Check size={16} className="ck" /> : <span className="num" />}
      </button>
      <div className="mm-sep" />
      <button className="mm-item" onClick={() => { onClose(); onManage(); }}>
        <SlidersHorizontal size={15} className="lead" />
        <span className="nm">Manage models…</span>
      </button>
    </div>
  );

  return (
    <div className="mmenu">
      {list.map((m, i) => {
        const sel = !uc && settings.model === m.id;
        return (
          <button key={m.id} className={'mm-item' + (sel ? ' sel' : '')} onClick={() => choose(m)} title={m.description}>
            <span className="nm">{m.name}</span>
            {NOTE[m.id] && <span className="note"><Info size={12} /> {NOTE[m.id]}</span>}
            <span className="sp" />
            {sel ? <Check size={16} className="ck" /> : <span className="num">{i + 1}</span>}
          </button>
        );
      })}
      <div className="mm-sep" />
      <button className="mm-item" onClick={() => setView('effort')}>
        <span className="nm">Effort</span>
        <span className="sp" />
        <span className="val">{effort?.name}</span>
        <ChevronRight size={16} className="chev" />
      </button>
      <div className="mm-sep" />
      <button className="mm-item" onClick={() => setView('more')}>
        <span className="nm">More models</span>
        <span className="sp" />
        {(settings.model === 'auto' || uc) && <span className="val">{uc ? 'Colossus 2.2 UC' : 'Auto'}</span>}
        <ChevronRight size={16} className="chev" />
      </button>
    </div>
  );
}
