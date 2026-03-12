const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('systemAPI', {
  onSystemData: (callback) => ipcRenderer.on('system-data', (event, data) => callback(data)),
  onLayoutChange: (callback) => ipcRenderer.on('layout-change', (event, mode) => callback(mode)),
  onLockChange: (callback) => ipcRenderer.on('lock-change', (event, locked) => callback(locked)),
  resizeWindow: (height) => ipcRenderer.send('resize-window', height),
  setIgnoreMouse: (ignore) => {
    ipcRenderer.send('set-ignore-mouse', ignore);
  }
});
