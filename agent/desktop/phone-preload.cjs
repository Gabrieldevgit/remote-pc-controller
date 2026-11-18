// Preload for the phone viewer window (phone-viewer.html). Signaling and the
// Supabase session stay in the main process; this exposes a narrow API.
const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('phone', {
  start: phoneId => ipcRenderer.invoke('phone:start', phoneId),
  signal: (event, payload) => ipcRenderer.send('phone:signal', {event, payload}),
  end: reason => ipcRenderer.invoke('phone:end', reason),
  fit: size => ipcRenderer.invoke('phone:fit', size),
  window: (action, value) => ipcRenderer.invoke('phone:window', {action, value}),
  onWindowState: listener => ipcRenderer.on('phone:window-state', (_event, value) => listener(value)),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: text => ipcRenderer.invoke('clipboard:write', text),
  onEvent: listener => ipcRenderer.on('phone:event', (_event, value) => listener(value)),
});
