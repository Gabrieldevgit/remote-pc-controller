const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('host', {
  identity: () => ipcRenderer.invoke('agent:identity'),
  status: () => ipcRenderer.invoke('agent:status'),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  pair: request => ipcRenderer.invoke('agent:pair', request),
  setRelay: url => ipcRenderer.invoke('agent:relay', url),
  onLog: listener => ipcRenderer.on('agent:log', (_event, value) => listener(value)),
  onState: listener => ipcRenderer.on('agent:state', (_event, value) => listener(value)),
});
