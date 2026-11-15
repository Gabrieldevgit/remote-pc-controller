const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('host', {
  identity: () => ipcRenderer.invoke('agent:identity'),
  status: () => ipcRenderer.invoke('agent:status'),
  start: () => ipcRenderer.invoke('agent:start'),
  stop: () => ipcRenderer.invoke('agent:stop'),
  pair: request => ipcRenderer.invoke('agent:pair', request),
  setPin: pin => ipcRenderer.invoke('agent:set-pin', pin),
  setRelay: url => ipcRenderer.invoke('agent:relay', url),
  startSupport: () => ipcRenderer.invoke('support:start'),
  stopSupport: () => ipcRenderer.invoke('support:stop'),
  answerSupport: answer => ipcRenderer.invoke('support:answer', answer),
  accountState: () => ipcRenderer.invoke('account:state'),
  signIn: request => ipcRenderer.invoke('account:sign-in', request),
  signUp: request => ipcRenderer.invoke('account:sign-up', request),
  signOut: () => ipcRenderer.invoke('account:sign-out'),
  history: () => ipcRenderer.invoke('account:history'),
  phones: () => ipcRenderer.invoke('phones:list'),
  openPhone: phone => ipcRenderer.invoke('phones:open', phone),
  onLog: listener => ipcRenderer.on('agent:log', (_event, value) => listener(value)),
  onState: listener => ipcRenderer.on('agent:state', (_event, value) => listener(value)),
  onSupport: listener => ipcRenderer.on('support:event', (_event, value) => listener(value)),
});
