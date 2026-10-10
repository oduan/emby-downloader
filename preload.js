'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listServers: () => ipcRenderer.invoke('listServers'),
  addServer: (payload) => ipcRenderer.invoke('addServer', payload),
  removeServer: (id) => ipcRenderer.invoke('removeServer', id),
  getViews: (serverId) => ipcRenderer.invoke('getViews', serverId),
  getItems: (payload) => ipcRenderer.invoke('getItems', payload),
  getChildren: (payload) => ipcRenderer.invoke('getChildren', payload),
  getSettings: () => ipcRenderer.invoke('getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('setSettings', patch),
  chooseDownloadPath: () => ipcRenderer.invoke('chooseDownloadPath'),
  startDownload: (payload) => ipcRenderer.invoke('startDownload', payload),
  cancelDownload: (id) => ipcRenderer.invoke('cancelDownload', id),
  retryDownload: (id) => ipcRenderer.invoke('retryDownload', id),
  removeDownload: (id) => ipcRenderer.invoke('removeDownload', id),
  clearFinishedDownloads: () => ipcRenderer.invoke('clearFinishedDownloads'),
  listDownloads: () => ipcRenderer.invoke('listDownloads'),
  openDownloadFolder: () => ipcRenderer.invoke('openDownloadFolder'),
  onDownloadChange: (cb) => {
    const listener = (_event, task) => cb(task);
    ipcRenderer.on('download:change', listener);
    return () => ipcRenderer.removeListener('download:change', listener);
  },
});
