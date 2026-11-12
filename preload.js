// Omnis Auxiliary Screens preload: the only bridge between the screens / setup page and the app.
const { contextBridge, ipcRenderer } = require('electron');

// Wall screens: data from the tv-screens server function (fetched and cached by the main process)
contextBridge.exposeInMainWorld('tvAPI', {
  getData: () => ipcRenderer.invoke('tv:getData'),
  briefing: (payload) => ipcRenderer.invoke('tv:briefing', payload),
});

// Setup page
contextBridge.exposeInMainWorld('tvSetup', {
  get: () => ipcRenderer.invoke('tv:setup:get'),
  test: (pin) => ipcRenderer.invoke('tv:setup:test', pin),
  save: (data) => ipcRenderer.invoke('tv:setup:save', data),
  identify: () => ipcRenderer.invoke('tv:setup:identify'),
  quit: () => ipcRenderer.invoke('tv:quit'),
  minimize: () => ipcRenderer.invoke('tv:win:minimize'),
  close: () => ipcRenderer.invoke('tv:win:close'),
  fit: (h) => ipcRenderer.invoke('tv:win:fit', h),
});

