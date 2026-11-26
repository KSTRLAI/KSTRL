const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('kstrl', {
  info: invoke('app:info'),
  settings: { get: invoke('settings:get'), update: invoke('settings:update') },
  workspace: { pick: invoke('workspace:pick'), open: invoke('workspace:open'), current: invoke('workspace:current'), close: invoke('workspace:close') },
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
  term: {
    create: invoke('term:create'), write: invoke('term:write'), resize: invoke('term:resize'), kill: invoke('term:kill'),
    onData: on('term:data'), onExit: on('term:exit'),
  },
});
