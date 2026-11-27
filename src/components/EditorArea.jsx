import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { X, ChevronRight, Sparkles, Loader2, Check, Undo2 } from 'lucide-react';
import { monaco } from '../lib/monaco.js';
import { languageFor, colorFor } from '../lib/lang.js';

// Model registry: one Monaco model per open file.
export const docs = new Map(); // path -> { model, savedVersion, viewState }

export function ensureDoc(path, content) {
  let d = docs.get(path);
  if (!d) {
    const model = monaco.editor.createModel(content, languageFor(path), monaco.Uri.file('/workspace/' + path));
    d = { model, savedVersion: model.getAlternativeVersionId(), viewState: null };
    docs.set(path, d);
  }
  return d;
}

export function disposeDoc(path) {
  const d = docs.get(path);
  if (d) { d.model.dispose(); docs.delete(path); }
}

export const isDirty = (path) => { const d = docs.get(path); return !!d && d.model.getAlternativeVersionId() !== d.savedVersion; };

const EditorArea = forwardRef(function EditorArea({ tabs, active, onActivate, onClose, onDirtyChange, onSave, model: modelId, fontSize, minimap = true, wordWrap = false, onToast, onAddSelection }, ref) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const activeRef = useRef(active);
  const [inline, setInline] = useState(null); // { top, phase: 'input'|'busy'|'review', text }
  const inlineRef = useRef(null);
  activeRef.current = active;

  useEffect(() => {
    const editor = monaco.editor.create(hostRef.current, {
      theme: 'kstrl-dark',
      automaticLayout: true,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontLigatures: true,
      fontSize,
      lineHeight: 1.6,
      minimap: { enabled: true, renderCharacters: false, scale: 1 },
      smoothScrolling: true,
      cursorSmoothCaretAnimation: 'on',
      cursorBlinking: 'smooth',
      renderLineHighlight: 'all',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: 'active', indentation: true },
      stickyScroll: { enabled: true },
      padding: { top: 8 },
      scrollBeyondLastLine: false,
      tabSize: 2,
      inlineSuggest: { enabled: true, mode: 'subwordSmart' },
      model: null,
    });
    editorRef.current = editor;

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => activeRef.current && onSave(activeRef.current));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInline());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => onAddSelection());
    editor.addAction({ id: 'kstrl.inline', label: 'Kestrel: Edit Selection (Ctrl+K)', contextMenuGroupId: '0_kestrel', contextMenuOrder: 1, run: () => openInline() });
    editor.addAction({ id: 'kstrl.addchat', label: 'Kestrel: Add Selection to Chat (Ctrl+L)', contextMenuGroupId: '0_kestrel', contextMenuOrder: 2, run: () => onAddSelection() });

    const sub = editor.onDidChangeModelContent(() => activeRef.current && onDirtyChange(activeRef.current, isDirty(activeRef.current)));
    return () => { sub.dispose(); editor.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { editorRef.current?.updateOptions({ fontSize, minimap: { enabled: minimap, renderCharacters: false }, wordWrap: wordWrap ? 'on' : 'off' }); }, [fontSize, minimap, wordWrap]);

  // Swap models when the active tab changes, keeping scroll/cursor per file.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const current = editor.getModel();
    if (current) {
      for (const d of docs.values()) if (d.model === current) d.viewState = editor.saveViewState();
    }
    setInline(null);
    const d = active ? docs.get(active) : null;
    editor.setModel(d ? d.model : null);
    if (d?.viewState) editor.restoreViewState(d.viewState);
    if (d) editor.focus();
  }, [active, tabs.length]);

  const openInline = () => {
    const editor = editorRef.current;
    if (!editor || !editor.getModel()) return;
    let sel = editor.getSelection();
    if (sel.isEmpty()) {
      // No selection: target the current line so "Ctrl+K" can also generate code in place.
      sel = new monaco.Selection(sel.startLineNumber, 1, sel.startLineNumber, editor.getModel().getLineMaxColumn(sel.startLineNumber));
      editor.setSelection(sel);
    }
    const pos = editor.getScrolledVisiblePosition({ lineNumber: sel.startLineNumber, column: 1 });
    setInline({ top: Math.max(8, (pos?.top ?? 0) - 92), phase: 'input', text: '', selection: sel });
    setTimeout(() => inlineRef.current?.focus(), 0);
  };

  const runInline = async (instruction) => {
    const editor = editorRef.current;
    const model = editor.getModel();
    const sel = inline.selection;
    if (!instruction.trim() || !model) return;
    setInline((s) => ({ ...s, phase: 'busy', text: instruction }));
    const full = model.getValue();
    const startOff = model.getOffsetAt(sel.getStartPosition());
    const endOff = model.getOffsetAt(sel.getEndPosition());
    try {
      const out = await window.kstrl.agent.inlineEdit({
        instruction,
        code: full.slice(startOff, endOff),
        language: model.getLanguageId(),
        path: activeRef.current,
        before: full.slice(Math.max(0, startOff - 6000), startOff),
        after: full.slice(endOff, endOff + 3000),
        model: modelId,
      });
      if (editor.getModel() !== model) return;
      editor.pushUndoStop();
      editor.executeEdits('kestrel-inline', [{ range: sel, text: out, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      const endPos = model.getPositionAt(startOff + out.length);
      editor.setSelection(new monaco.Selection(sel.startLineNumber, sel.startColumn, endPos.lineNumber, endPos.column));
      setInline((s) => ({ ...s, phase: 'review' }));
    } catch (e) {
      onToast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setInline((s) => ({ ...s, phase: 'input' }));
    }
  };

  const acceptInline = () => { setInline(null); editorRef.current?.focus(); };
  const rejectInline = () => { editorRef.current?.trigger('kestrel', 'undo'); setInline(null); editorRef.current?.focus(); };

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    openInline,
    revealLine: (line) => {
      const e = editorRef.current;
      if (!e) return;
      e.revealLineInCenter(line);
      e.setPosition({ lineNumber: line, column: 1 });
      e.focus();
    },
    getSelection: () => {
      const e = editorRef.current;
      const m = e?.getModel();
      if (!m) return null;
      const s = e.getSelection();
      if (s.isEmpty()) return null;
      return { path: activeRef.current, startLine: s.startLineNumber, endLine: s.endLineNumber, text: m.getValueInRange(s), language: m.getLanguageId() };
    },
  }));

  const crumbs = active ? active.split('/') : [];

  return (
    <div className="editor-wrap">
      <div className="tabs">
        {tabs.map((t) => (
          <div key={t.path} className={'tab' + (t.path === active ? ' active' : '')} onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(t.path); } else onActivate(t.path); }} title={t.path}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(t.path) }} />
            <span>{t.path.split('/').pop()}</span>
            <span className={'close' + (t.dirty ? ' dirty' : '')} onMouseDown={(e) => { e.stopPropagation(); onClose(t.path); }}><X size={13} /></span>
          </div>
        ))}
      </div>
      {active && (
        <div className="breadcrumbs">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ChevronRight size={11} />}
              <span style={i === crumbs.length - 1 ? { color: 'var(--text-2)' } : null}>{c}</span>
            </React.Fragment>
          ))}
          <span style={{ marginLeft: 'auto', fontSize: 11.5 }}>Ctrl+K edit · Ctrl+L add to chat</span>
        </div>
      )}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {inline && (
          <div className="inline-edit glass-strong" style={{ top: inline.top }} onMouseDown={(e) => e.stopPropagation()}>
            {inline.phase === 'review' ? (
              <div className="row">
                <Sparkles size={14} color="var(--accent)" />
                <span style={{ fontSize: 12.5 }}>{inline.text}</span>
                <span className="spacer" />
                <button className="btn" onClick={rejectInline}><Undo2 size={13} /> Reject <span className="hint">Esc</span></button>
                <button className="btn primary" onClick={acceptInline} autoFocus onKeyDown={(e) => e.key === 'Escape' && rejectInline()}><Check size={13} /> Accept <span className="hint" style={{ color: 'inherit' }}>Enter</span></button>
              </div>
            ) : (
              <>
                <div className="row">
                  {inline.phase === 'busy' ? <Loader2 size={14} className="spin" color="var(--accent)" /> : <Sparkles size={14} color="var(--accent)" />}
                  <input
                    ref={inlineRef}
                    disabled={inline.phase === 'busy'}
                    placeholder="Edit selection — e.g. 'add error handling', 'convert to async/await'"
                    defaultValue={inline.text}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') runInline(e.currentTarget.value);
                      if (e.key === 'Escape') { setInline(null); editorRef.current?.focus(); }
                    }}
                  />
                </div>
                <div className="row"><span className="hint">{inline.phase === 'busy' ? 'Kestrel is writing…' : 'Enter to generate · Esc to cancel'}</span></div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

export default EditorArea;
