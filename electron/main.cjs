const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const settings = require('./settings.cjs');
const ws = require('./workspace.cjs');
const { AgentManager } = require('./agent.cjs');
const { TerminalManager } = require('./terminal.cjs');
const { MODELS, EFFORTS } = require('./models.cjs');
const updater = require('./updater.cjs');

const isDev = !!process.env.KSTRL_DEV;
let win = null;
let watcher = null;
let tray = null;

function applyTray() {
  const want = !!settings.load().trayIcon;
  if (want && !tray) {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', isDev ? 'public' : 'dist', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('KSTRL');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show KSTRL', click: () => { if (win) { win.show(); win.focus(); } } },
      { label: 'New Chat', click: () => { if (win) { win.show(); win.focus(); send('app:command', 'newchat'); } } },
      { type: 'separator' },
      { label: 'Quit KSTRL', click: () => app.quit() },
    ]));
    tray.on('click', () => { if (win) { win.show(); win.focus(); } });
  } else if (!want && tray) { tray.destroy(); tray = null; }
}

app.setAppUserModelId('ai.kstrl.app');
nativeTheme.themeSource = 'dark';

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const agent = new AgentManager(send);
const terms = new TerminalManager(send);

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: 'KSTRL',
    backgroundColor: '#0e0e0e',
    icon: path.join(__dirname, '..', isDev ? 'public' : 'dist', 'icon.png'),
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0e0e0e', symbolColor: '#e5e5e5', height: 38 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Open external links in the system browser, never inside KSTRL.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && isDev) win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; });
}

function watch(root) {
  if (watcher) { try { watcher.close(); } catch {} watcher = null; }
  if (!root) return;
  let timer = null;
  const pending = new Set();
  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, file) => {
      if (!file) return;
      const rel = String(file).split(path.sep).join('/');
      if (/(^|\/)(node_modules|\.git)(\/|$)/.test(rel)) return;
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => { send('fs:tree', { paths: [...pending] }); pending.clear(); }, 250);
    });
  } catch {}
}

function openWorkspace(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('Folder not found: ' + dir);
  ws.setRoot(dir);
  settings.addRecent(ws.getRoot());
  watch(ws.getRoot());
  if (win) win.setTitle(`${path.basename(dir)} — KSTRL`);
  return { root: ws.getRoot(), name: path.basename(ws.getRoot()) };
}

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, models: MODELS.map(({ fallback, ...m }) => m), efforts: EFFORTS }));
handle('settings:get', () => settings.publicView());
handle('settings:update', (patch) => {
  const r = settings.update(patch);
  if ('trayIcon' in patch) applyTray();
  if ('autoUpdate' in patch) updater.setAuto(patch.autoUpdate);
  return r;
});

handle('workspace:pick', async (opts) => {
  const r = await dialog.showOpenDialog(win, { title: opts?.title || 'Open Folder', buttonLabel: opts?.button, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return openWorkspace(r.filePaths[0]);
});
handle('workspace:open', (dir) => openWorkspace(dir));
handle('workspace:current', () => (ws.getRoot() ? { root: ws.getRoot(), name: path.basename(ws.getRoot()) } : null));
handle('workspace:close', () => { ws.setRoot(null); watch(null); settings.update({ lastFolder: null }); if (win) win.setTitle('KSTRL'); return true; });

handle('fs:readDir', (p) => ws.readDir(p));
handle('fs:readFile', (p) => ws.readFile(p));
handle('fs:writeFile', (p, c) => ws.writeFile(p, c));
handle('fs:create', (p, isDir) => ws.createPath(p, isDir));
handle('fs:delete', (p) => ws.deletePath(p));
handle('fs:rename', (a, b) => ws.renamePath(a, b));
handle('fs:walk', () => ws.walk('.', 20000));
handle('fs:search', (q, opts) => ws.search(q, opts, 1000));
handle('shell:reveal', (p) => shell.showItemInFolder(ws.resolveInside(p)));
handle('shell:openExternal', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });

handle('agent:run', (opts) => { agent.run(opts); return true; });
handle('agent:stop', (chatId) => agent.stop(chatId));
handle('agent:reset', (chatId) => agent.reset(chatId));
handle('agent:approve', (id, ok) => agent.resolveApproval(id, ok));
handle('agent:revert', (runId) => agent.revert(runId));
handle('agent:inlineEdit', (opts) => agent.inlineEdit(opts));
handle('server:test', async (opts) => {
  try { return await agent.testServer(opts || {}); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

handle('update:state', () => updater.getState());
handle('update:check', () => updater.check());
handle('update:install', () => updater.install());
handle('update:download', () => updater.download());

handle('term:create', (opts) => terms.create({ ...opts, cwd: ws.getRoot() || undefined }));
handle('term:write', (id, data) => terms.write(id, data));
handle('term:resize', (id, c, r) => terms.resize(id, c, r));
handle('term:kill', (id) => terms.kill(id));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    const s = settings.load();
    const appPath = path.resolve(app.getAppPath());
    const argDir = process.argv.slice(1).find((a) => !a.startsWith('-') && path.resolve(a) !== appPath && fs.existsSync(a) && fs.statSync(a).isDirectory());
    try { if (argDir) openWorkspace(argDir); else if (s.reopenLastProject !== false && s.lastFolder && fs.existsSync(s.lastFolder)) openWorkspace(s.lastFolder); } catch {}
    createWindow();
    updater.init(send);
    applyTray();
  });
}

app.on('window-all-closed', () => { terms.killAll(); app.quit(); });
