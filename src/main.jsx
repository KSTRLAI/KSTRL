import React from 'react';
import { createRoot } from 'react-dom/client';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import './lib/monaco.js';
import './lib/autocomplete.js';
import App from './App.jsx';

if (window.kstrl?.platform === 'darwin') document.documentElement.classList.add('mac');

createRoot(document.getElementById('root')).render(<App />);
