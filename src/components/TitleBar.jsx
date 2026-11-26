import React, { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export default function TitleBar({ menus, workspace, onOmni }) {
  const [open, setOpen] = useState(null); // { index, x, y }
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(null); };
    const esc = (e) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open]);

  const openAt = (i, el) => {
    const r = el.getBoundingClientRect();
    setOpen({ index: i, x: r.left, y: r.bottom + 4 });
  };

  return (
    <div className="titlebar" ref={ref}>
      <img className="logo" src="./icon.png" alt="" />
      <span className="brand">KSTRL</span>
      {menus.map((m, i) => (
        <button
          key={m.label}
          className={'menu-btn' + (open?.index === i ? ' open' : '')}
          onMouseDown={(e) => { e.stopPropagation(); open?.index === i ? setOpen(null) : openAt(i, e.currentTarget); }}
          onMouseEnter={(e) => open && open.index !== i && openAt(i, e.currentTarget)}
        >
          {m.label}
        </button>
      ))}
      <div className="center">
        <button className="omni" onClick={onOmni}>
          <Search size={12} /> {workspace ? workspace.name : 'KSTRL'} <span style={{ opacity: 0.6 }}>· Ctrl+P</span>
        </button>
      </div>
      {open && (
        <div className="dropdown glass-strong" style={{ left: open.x, top: open.y }} onMouseDown={(e) => e.stopPropagation()}>
          {menus[open.index].items.map((it, j) =>
            it === '-' ? (
              <div key={j} className="sep" />
            ) : (
              <button key={j} className="item" disabled={it.disabled} onClick={() => { setOpen(null); it.run(); }}>
                <span>{it.label}</span>
                {it.kbd && <span className="kbd">{it.kbd}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
