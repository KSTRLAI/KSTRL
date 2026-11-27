// Ctrl on Windows, Cmd on macOS.
export const isMac = window.kstrl?.platform === 'darwin';
export const mod = (e) => (isMac ? e.metaKey : e.ctrlKey);
export const fmtKbd = (s) => (isMac && s ? s.replace(/Ctrl\+Shift\+/g, '⇧⌘').replace(/Ctrl\+Alt\+/g, '⌥⌘').replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥') : s);
