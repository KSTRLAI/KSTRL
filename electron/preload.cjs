const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('kstrl', {
  info: invoke('app:info'),
  settings: { get: invoke('settings:get'), update: invoke('settings:update'), onChanged: on('settings:changed') },
  workspace: { pick: invoke('workspace:pick'), open: invoke('workspace:open'), current: invoke('workspace:current'), close: invoke('workspace:close'), onChanged: on('workspace:changed') },
  windows: { openIde: invoke('window:openIde'), idePending: invoke('window:idePending'), focusHome: invoke('window:focusHome') },
  git: { clone: invoke('git:clone') },
  fs: {
    readDir: invoke('fs:readDir'), readFile: invoke('fs:readFile'), writeFile: invoke('fs:writeFile'),
    create: invoke('fs:create'), delete: invoke('fs:delete'), rename: invoke('fs:rename'),
    walk: invoke('fs:walk'), search: invoke('fs:search'),
    onChanged: on('fs:changed'), onTree: on('fs:tree'),
  },
  shell: { reveal: invoke('shell:reveal'), openExternal: invoke('shell:openExternal') },
  agent: {
    run: invoke('agent:run'), stop: invoke('agent:stop'), reset: invoke('agent:reset'),
    approve: invoke('agent:approve'), revert: invoke('agent:revert'), inlineEdit: invoke('agent:inlineEdit'),
    onEvent: on('agent:event'),
  },
  server: { test: invoke('server:test') },
  onCommand: on('app:command'),
  isFocused: () => document.hasFocus(),
  update: { state: invoke('update:state'), check: invoke('update:check'), install: invoke('update:install'), download: invoke('update:download'), onStatus: on('update:status') },
  term: {
    create: invoke('term:create'), write: invoke('term:write'), resize: invoke('term:resize'), kill: invoke('term:kill'),
    onData: on('term:data'), onExit: on('term:exit'),
  },
});
