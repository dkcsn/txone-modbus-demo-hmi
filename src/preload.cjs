const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hmi', {
  getState: () => ipcRenderer.invoke('hmi:get-state'),
  selectDemo: (id) => ipcRenderer.invoke('hmi:select-demo', id),
  updateConfig: (id, config) => ipcRenderer.invoke('hmi:update-config', id, config),
  setAutoReconnect: (id, enabled) => ipcRenderer.invoke('hmi:set-auto-reconnect', id, enabled),
  connect: (id) => ipcRenderer.invoke('hmi:connect', id),
  disconnect: (id) => ipcRenderer.invoke('hmi:disconnect', id),
  retry: (id) => ipcRenderer.invoke('hmi:retry', id),
  command: (id, command, payload) => ipcRenderer.invoke('hmi:command', id, command, payload),
  getLogPath: () => ipcRenderer.invoke('hmi:get-log-path'),
  getNetworks: () => ipcRenderer.invoke('hmi:get-networks'),
  openLogFolder: () => ipcRenderer.invoke('hmi:open-log-folder'),
  discover: (id) => ipcRenderer.invoke('hmi:discover', id),
  checkUpdate: () => ipcRenderer.invoke('hmi:check-update'),
  openUpdate: () => ipcRenderer.invoke('hmi:open-update'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('hmi:state', listener);
    return () => ipcRenderer.removeListener('hmi:state', listener);
  },
  onUpdate: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('hmi:update', listener);
    return () => ipcRenderer.removeListener('hmi:update', listener);
  },
  onLog: (callback) => {
    const listener = (_event, entry) => callback(entry);
    ipcRenderer.on('hmi:log', listener);
    return () => ipcRenderer.removeListener('hmi:log', listener);
  },
});
