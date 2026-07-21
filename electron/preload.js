'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  close: () => ipcRenderer.send('window:close'),
  onMaximizedChange: (callback) => {
    ipcRenderer.on('window:maximized-change', (_event, isMaximized) => callback(isMaximized))
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, status) => callback(status))
  },
  restartAndInstallUpdate: () => ipcRenderer.send('update:restart-and-install')
})
