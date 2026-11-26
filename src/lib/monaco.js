import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_id, label) {
    if (label === 'json') return new JsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new CssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new HtmlWorker();
    if (['typescript', 'javascript'].includes(label)) return new TsWorker();
    return new EditorWorker();
  },
};

monaco.editor.defineTheme('kstrl-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6b6b74', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff6b6b' },
    { token: 'string', foreground: 'f2c879' },
    { token: 'number', foreground: 'ffa07a' },
    { token: 'type', foreground: '7fd3ff' },
    { token: 'type.identifier', foreground: '7fd3ff' },
    { token: 'function', foreground: 'ffffff' },
    { token: 'variable', foreground: 'e6e6e6' },
    { token: 'delimiter', foreground: 'a0a0a8' },
    { token: 'tag', foreground: 'ff6b6b' },
    { token: 'attribute.name', foreground: 'f2c879' },
  ],
  colors: {
    'editor.background': '#111113',
    'editor.foreground': '#e6e6e6',
    'editorLineNumber.foreground': '#45454d',
    'editorLineNumber.activeForeground': '#f4f4f5',
    'editor.selectionBackground': '#ffffff26',
    'editor.inactiveSelectionBackground': '#ffffff14',
    'editor.lineHighlightBackground': '#ffffff08',
    'editorCursor.foreground': '#ffffff',
    'editorIndentGuide.background1': '#ffffff0d',
    'editorIndentGuide.activeBackground1': '#ffffff26',
    'editorWidget.background': '#16161a',
    'editorWidget.border': '#ffffff1a',
    'editorSuggestWidget.selectedBackground': '#ffffff1f',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff24',
    'minimap.background': '#111113',
    'diffEditor.insertedTextBackground': '#2ea04333',
    'diffEditor.removedTextBackground': '#ff3d3d33',
  },
});

loader.config({ monaco });
export { monaco };
