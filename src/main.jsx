import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './lib/monaco.js';
import './lib/autocomplete.js';
import App from './App.jsx';

// Renderer errors go to the crash log (and, if the user opted in, to KSTRL).
window.addEventListener('error', (e) => { if (!/ResizeObserver loop/.test(e.message)) window.kstrl?.log.error('renderer', e.message, e.error?.stack); });
window.addEventListener('unhandledrejection', (e) => window.kstrl?.log.error('renderer', String(e.reason?.message || e.reason), e.reason?.stack));

if (window.kstrl?.platform === 'darwin') document.documentElement.classList.add('mac');

createRoot(document.getElementById('root')).render(<App />);
