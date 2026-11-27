const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, Tray, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const settings = require('./settings.cjs');
const ws = require('./workspace.cjs');
const { AgentManager } = require('./agent.cjs');
const { TerminalManager } = require('./terminal.cjs');
const { MODELS, EFFORTS, MODES, PLANS } = require('./models.cjs');
const { spawn } = require('node:child_process');
const updater = require('./updater.cjs');
const auth = require('./auth.cjs');
const gitOps = require('./git.cjs');
const crash = require('./crash.cjs');

const isDev = !!process.env.KSTRL_DEV;
let win = null; // Agents home window
let ideWin = null; // IDE window (opened from the home window)
let idePending = null; // file/line or action for the IDE window to pick up once loaded
let watcher = null;
let tray = null;

function applyTray() {
  const want = !!settings.load().trayIcon;
  if (want && !tray) {
    const img = nativeImage.createFromPath(path.join(__dirname, '..', isDev ? 'public' : 'dist', 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('KSTRL');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show KSTRL', click: () => focusHome() },
      { label: 'New Chat', click: () => focusHome('newchat') },
      { type: 'separator' },
      { label: 'Quit KSTRL', click: () => app.quit() },
    ]));
    tray.on('click', () => focusHome());
  } else if (!want && tray) { tray.destroy(); tray = null; }
}

app.setAppUserModelId('ai.kstrl.app');
nativeTheme.themeSource = 'dark';

// Every window gets every event; each renderer only acts on its own chats and terminals.
const send = (channel, payload) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload); };
const focused = () => BrowserWindow.getFocusedWindow() || win || ideWin;
const wsTitle = () => (ws.getRoot() ? `${path.basename(ws.getRoot())} — KSTRL` : 'KSTRL');
const agent = new AgentManager(send);
const terms = new TerminalManager(send);

function createWindow(kind = 'home') {
  const w = new BrowserWindow({
    width: kind === 'ide' ? 1400 : 1480,
    height: kind === 'ide' ? 880 : 920,
    minWidth: 900,
    minHeight: 560,
    title: wsTitle(),
    backgroundColor: kind === 'ide' ? '#1b1b1b' : '#0e0e0e',
    icon: path.join(__dirname, '..', isDev ? 'public' : 'dist', 'icon.png'),
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 14, y: 12 } }
      : { titleBarOverlay: { color: kind === 'ide' ? '#161616' : '#0b0b0b', symbolColor: '#e5e5e5', height: 38 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  // Windows: menus live in the window. macOS needs an app menu for Cmd+C/V/Q and window handling.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  w.once('ready-to-show', () => { if (kind === 'home') w.maximize(); w.show(); });
  if (isDev) w.loadURL('http://localhost:5173' + (kind === 'ide' ? '/#ide' : ''));
  else w.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), kind === 'ide' ? { hash: 'ide' } : undefined);

  // Open external links in the system browser, never inside KSTRL.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && isDev) w.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') w.webContents.toggleDevTools();
  });
  if (kind === 'ide') { ideWin = w; w.on('closed', () => { ideWin = null; }); }
  else { win = w; w.on('closed', () => { win = null; }); }
  return w;
}

function openIde(payload) {
  if (ideWin && !ideWin.isDestroyed()) {
    if (ideWin.isMinimized()) ideWin.restore();
    ideWin.show(); ideWin.focus();
    if (payload) ideWin.webContents.send('app:command', { type: 'ide-open', ...payload });
  } else {
    idePending = payload || null;
    createWindow('ide');
  }
  return true;
}

function focusHome(payload) {
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  else createWindow('home');
  if (payload && win) win.webContents.send('app:command', payload);
  return true;
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
  const info = { root: ws.getRoot(), name: path.basename(ws.getRoot()) };
  for (const w of BrowserWindow.getAllWindows()) w.setTitle(wsTitle());
  send('workspace:changed', info);
  return info;
}

// Clone a Git repository into a folder the user picks, then open it.
async function cloneRepo(url) {
  url = String(url || '').trim();
  if (!/^(https?:\/\/|git@|ssh:\/\/)[^\s]+$/.test(url)) throw new Error('Enter a Git URL like https://github.com/owner/repo.git');
  const name = (url.split(/[/:]/).pop() || 'repo').replace(/\.git$/, '') || 'repo';
  const r = await dialog.showOpenDialog(focused(), { title: `Choose where to clone ${name}`, buttonLabel: 'Clone Here', properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const target = path.join(r.filePaths[0], name);
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  await new Promise((resolve, reject) => {
    let err = '';
    const p = spawn('git', ['clone', '--', url, target], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'Git is not installed. Install it from git-scm.com and try again.' : e.message)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error((err.trim().split('\n').pop() || `git exited with ${code}`).replace(/^fatal: /, '')))));
  });
  return openWorkspace(target);
}

const handle = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args));

// Chat history, one file per window kind.
const chatsFile = (kind) => path.join(app.getPath('userData'), `chats-${kind === 'ide' ? 'ide' : 'home'}.json`);
handle('chats:load', (kind) => { try { return JSON.parse(fs.readFileSync(chatsFile(kind), 'utf8')); } catch { return null; } });
handle('chats:save', (kind, data) => {
  const f = chatsFile(kind);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(data));
  fs.renameSync(f + '.tmp', f);
  return true;
});

handle('git:status', () => gitOps.status());
handle('git:diff', (p, staged) => gitOps.diff(p, staged));
handle('git:stage', (list) => gitOps.stage(list).then(() => gitOps.status()));
handle('git:unstage', (list) => gitOps.unstage(list).then(() => gitOps.status()));
handle('git:discard', (list) => gitOps.discard(list).then(() => gitOps.status()));
handle('git:commit', (msg) => gitOps.commit(msg));
handle('git:push', () => gitOps.push());
handle('git:pull', () => gitOps.pull());
handle('git:init', () => gitOps.init());
handle('git:message', async () => {
  const diff = await gitOps.diffForMessage();
  if (!diff.trim()) throw new Error('There are no changes to describe.');
  const text = await agent.quick({
    system: 'Write a git commit message for the diff. First line: imperative summary under 72 characters. If the change is large, add a blank line and up to 5 short bullet points. Reply with only the commit message.',
    user: diff, modelId: 'colossus-2.1', mode: 'commit', maxTokens: 300,
  });
  return text.replace(/^```\w*\n?|```$/g, '').trim();
});

handle('log:error', (source, message, stack) => crash.report(String(source || 'renderer'), { message: String(message || ''), stack: String(stack || '') }));
handle('log:openFolder', () => { fs.mkdirSync(crash.logsDir(), { recursive: true }); return shell.openPath(crash.logsDir()); });

handle('auth:login', () => auth.login());
handle('auth:logout', () => auth.logout());
handle('auth:refresh', () => auth.refresh());

// kstrl://auth?… links from the website (login). Windows passes them in argv; macOS uses open-url.
async function handleDeepLink(url) {
  if (!url || !/^kstrl:/i.test(url)) return;
  const r = await auth.handleUrl(url);
  focusHome();
  send('app:command', { type: 'auth', ...r });
}
const linkFrom = (argv) => (argv || []).find((a) => /^kstrl:/i.test(a));

handle('window:openIde', (payload) => openIde(payload));
handle('window:idePending', () => { const p = idePending; idePending = null; return p; });
handle('window:focusHome', (payload) => focusHome(payload));
handle('git:clone', (url) => cloneRepo(url));

handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, models: MODELS.map(({ fallback, ...m }) => m), efforts: EFFORTS, modes: MODES, plans: PLANS }));
handle('settings:get', () => settings.publicView());
handle('settings:update', (patch) => {
  const { plan, daily, usageToday, account, loggedIn, ...safe } = patch || {}; // plan, usage and account are not the renderer's to change
  const r = settings.update(safe);
  send('settings:changed', r);
  if ('trayIcon' in patch) applyTray();
  if ('autoUpdate' in patch) updater.setAuto(patch.autoUpdate);
  return r;
});

handle('workspace:pick', async (opts) => {
  const r = await dialog.showOpenDialog(focused(), { title: opts?.title || 'Open Folder', buttonLabel: opts?.button, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return openWorkspace(r.filePaths[0]);
});
handle('workspace:open', (dir) => openWorkspace(dir));
handle('workspace:current', () => (ws.getRoot() ? { root: ws.getRoot(), name: path.basename(ws.getRoot()) } : null));
handle('workspace:close', () => { ws.setRoot(null); watch(null); settings.update({ lastFolder: null }); for (const w of BrowserWindow.getAllWindows()) w.setTitle('KSTRL'); send('workspace:changed', null); return true; });

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
handle('agent:complete', (opts) => agent.complete(opts || {}));
handle('agent:cancelComplete', (id) => agent.cancelComplete(id));
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
  app.on('second-instance', (_e, argv) => { const link = linkFrom(argv); if (link) handleDeepLink(link); else focusHome(); });
  app.on('open-url', (e, url) => { e.preventDefault(); app.whenReady().then(() => handleDeepLink(url)); });
  if (app.isPackaged) app.setAsDefaultProtocolClient('kstrl'); // the installer registers it too
  app.whenReady().then(() => {
    const s = settings.load();
    const appPath = path.resolve(app.getAppPath());
    const argDir = process.argv.slice(1).find((a) => !a.startsWith('-') && path.resolve(a) !== appPath && fs.existsSync(a) && fs.statSync(a).isDirectory());
    try { if (argDir) openWorkspace(argDir); else if (s.reopenLastProject !== false && s.lastFolder && fs.existsSync(s.lastFolder)) openWorkspace(s.lastFolder); } catch {}
    crash.init();
    createWindow('home');
    auth.init(send);
    const startLink = linkFrom(process.argv);
    if (startLink) win.webContents.once('did-finish-load', () => handleDeepLink(startLink));
    setTimeout(() => auth.refresh(), 3000);
    setInterval(() => auth.refresh(), 10 * 60 * 1000);
    updater.init(send);
    applyTray();
  });
}

app.on('window-all-closed', () => { terms.killAll(); app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow('home'); });
