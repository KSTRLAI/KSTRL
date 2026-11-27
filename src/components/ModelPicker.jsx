import React, { useEffect, useState } from 'react';
import { Check, ChevronRight, ChevronLeft, Info, Wand2, SlidersHorizontal } from 'lucide-react';

// Flagship first, like the reference dropdown.
const ORDER = ['colossus-3', 'colossus-2.2', 'colossus-2.1'];
const NOTE = { 'colossus-3': 'Flagship' };

export const enabledModels = (info, settings) => {
  const all = (info?.models || []).filter((m) => !m.hidden).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  const on = settings.enabledModels;
  const list = Array.isArray(on) ? all.filter((m) => on.includes(m.id)) : all;
  return list.length ? list : all;
};

// Picks the model for a request: Plan → Colossus 2.1 (saves usage); UltraCode effort → Colossus 2.2 UC;
// "Auto" → by task size. The main process applies the same Plan/UltraCode rules.
export function resolveModel(info, settings, { text = '', contextCount = 0, mode } = {}) {
  const all = info?.models || [];
  if ((mode || settings.mode) === 'plan') {
    const m = all.find((x) => x.id === 'colossus-2.1');
    if (m) return { model: m, auto: false };
  }
  if (settings.effort === 'ultracode') {
    const uc = all.find((m) => m.id === 'colossus-2.2-uc');
    if (uc) return { model: uc, auto: false };
  }
  const list = enabledModels(info, settings);
  if (settings.model !== 'auto') return { model: list.find((m) => m.id === settings.model) || list[0], auto: false };
  const pick = (...ids) => ids.map((id) => list.find((m) => m.id === id)).find(Boolean) || list[0];
  const effort = settings.effort;
  let m;
  if (effort === 'max' || contextCount > 2 || text.length >= 1200) m = pick('colossus-3', 'colossus-2.2', 'colossus-2.1');
  else if (effort === 'high' || contextCount > 1 || text.length >= 600) m = pick('colossus-2.2', 'colossus-3', 'colossus-2.1');
  else if (mode === 'build' || contextCount > 0 || text.length >= 220) m = pick('colossus-2.1', 'colossus-2.2', 'colossus-3');
  else m = pick('colossus-2.1', 'colossus-2.2', 'colossus-3');
  return { model: m, auto: true };
}

// What the model button shows: the model in white and the effort in grey ("Colossus 3  High").
// UltraCode shows as an effort, never as "Colossus 2.2 UC".
export function modelParts(info, settings) {
  const effort = (info?.efforts || []).find((e) => e.id === settings.effort);
  let name;
  if (settings.mode === 'plan') name = 'Colossus 2.1';
  else if (settings.model === 'auto') name = 'Auto';
  else name = (info?.models || []).find((m) => m.id === settings.model)?.name || 'Model';
  return { name, effort: effort?.name || '' };
}

// Name shown on a reply. UltraCode runs Colossus 2.2 UC under the hood but is shown as an effort.
export function runLabel(info, settings, model, auto) {
  if (!model) return '';
  if (model.id === 'colossus-2.2-uc') return `${modelParts(info, settings).name} · UltraCode`;
  return auto ? `${model.name} · Auto` : model.name;
}

export function modelLabel(info, settings) {
  const p = modelParts(info, settings);
  return p.effort ? `${p.name} ${p.effort}` : p.name;
}

export function ModelMenu({ info, settings, onSettings, onClose, onManage }) {
  const [view, setView] = useState('models'); // models | effort | more
  const list = enabledModels(info, settings);
  const efforts = info?.efforts || [];
  const effort = efforts.find((e) => e.id === settings.effort) || efforts[1];
  const plan = settings.mode === 'plan';

  const choose = (m) => { onSettings({ model: m.id }); onClose(); };

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
      <button className="mm-item" onClick={() => { onSettings({ model: 'auto' }); onClose(); }}>
        <Wand2 size={15} className="lead" />
        <span className="nm">Auto</span>
        <span className="desc">Picks a Colossus model for each request</span>
        {settings.model === 'auto' ? <Check size={16} className="ck" /> : <span className="num" />}
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
      {plan && <div className="mm-hint">Plan mode always uses Colossus 2.1 to save usage. Your pick applies to Build and Ask.</div>}
      {list.map((m, i) => {
        const sel = settings.model === m.id;
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
        {settings.model === 'auto' && <span className="val">Auto</span>}
        <ChevronRight size={16} className="chev" />
      </button>
    </div>
  );
}
