import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, Zap, Code2, Brain, Sparkles, Wand2, Rocket, SlidersHorizontal } from 'lucide-react';

const TAG_ICON = { Fast: Zap, Ultracode: Code2, Reasoning: Brain, Flagship: Sparkles };

export const enabledModels = (info, settings) => {
  const all = (info?.models || []).filter((m) => !m.hidden);
  const on = settings.enabledModels;
  const list = Array.isArray(on) ? all.filter((m) => on.includes(m.id)) : all;
  return list.length ? list : all;
};

// "Auto": pick a Colossus model for this request.
export function resolveModel(info, settings, { text = '', contextCount = 0, mode } = {}) {
  if (settings.effort === 'ultracode') {
    const uc = (info?.models || []).find((m) => m.id === 'colossus-2.2-uc');
    if (uc) return { model: uc, auto: false };
  }
  const list = enabledModels(info, settings);
  if (settings.model !== 'auto') return { model: list.find((m) => m.id === settings.model) || list[list.length - 1], auto: false };
  const pick = (...ids) => ids.map((id) => list.find((m) => m.id === id)).find(Boolean) || list[list.length - 1];
  const effort = settings.effort;
  let m;
  // Quick, short questions go to Colossus 2; everything else to the flagship.
  if (effort === 'max' || effort === 'high' || mode === 'agent' || contextCount > 0 || text.length >= 220) m = pick('colossus-3', 'colossus-2');
  else m = pick('colossus-2', 'colossus-3');
  return { model: m, auto: true };
}

export function modelLabel(info, settings) {
  if (settings.effort === 'ultracode') return 'Colossus 2.2 UC';
  if (settings.model === 'auto') return 'Auto';
  return (info?.models || []).find((m) => m.id === settings.model)?.name || 'Model';
}

export function ModelMenu({ info, settings, onSettings, onClose, onManage }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const auto = settings.model === 'auto';
  const max = settings.effort === 'max';
  const list = useMemo(() => enabledModels(info, settings).filter((m) => !q || `${m.name} ${m.tag} ${m.description}`.toLowerCase().includes(q.toLowerCase())), [info, settings, q]);

  return (
    <div className="model-menu">
      <div className="mm-search">
        <Search size={13} />
        <input ref={inputRef} placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && list[0]) { onSettings({ model: list[0].id }); onClose(); } }} />
      </div>
      {!q && (
        <>
          <div className="mm-toggle" onClick={() => onSettings({ model: auto ? (settings.lastManualModel || 'colossus-3') : 'auto', ...(auto ? {} : { lastManualModel: settings.model }) })}>
            <Wand2 size={14} />
            <div className="txt"><div className="n">Auto</div><div className="d">Picks the best Colossus model for each request</div></div>
            <button className={'toggle sm' + (auto ? ' on' : '')} />
          </div>
          <div className="mm-toggle" onClick={() => onSettings({ effort: max ? 'normal' : 'max' })}>
            <Rocket size={14} />
            <div className="txt"><div className="n">MAX Mode</div><div className="d">Full effort and deepest reasoning on every request</div></div>
            <button className={'toggle sm' + (max ? ' on' : '')} />
          </div>
          <div className="mm-sep" />
        </>
      )}
      {settings.effort === 'ultracode' && !q && (
        <div className="mm-note"><Code2 size={13} /> UltraCode effort is on, so Kestrel uses Colossus 2.2 UC. Change the effort to pick another model.</div>
      )}
      <div className="mm-list">
        {list.map((m) => {
          const I = TAG_ICON[m.tag] || Sparkles;
          const sel = !auto && settings.model === m.id;
          return (
            <button key={m.id} className={'mm-row' + (sel ? ' sel' : '') + (auto || settings.effort === 'ultracode' ? ' dim' : '')} title={m.description} onClick={() => { onSettings({ model: m.id, ...(settings.effort === 'ultracode' ? { effort: 'normal' } : {}) }); onClose(); }}>
              <span className="nm">{m.name}</span>
              <I size={12} className="tag-ic" />
              {m.tag === 'Flagship' && <span className="badge">Flagship</span>}
              <span className="sp" />
              {sel && <Check size={14} />}
            </button>
          );
        })}
        {list.length === 0 && <div className="mm-empty">No models match “{q}”</div>}
      </div>
      <div className="mm-sep" />
      <button className="mm-row foot" onClick={() => { onClose(); onManage(); }}><SlidersHorizontal size={13} /> <span className="nm">Manage models…</span></button>
    </div>
  );
}
