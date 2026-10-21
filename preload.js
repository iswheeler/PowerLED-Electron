const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openProject: () => ipcRenderer.invoke('project:open'),
  openPath: (p) => ipcRenderer.invoke('project:open-path', p),
  saveProject: (opts) => ipcRenderer.invoke('project:save', opts),
  readImage: (imgPath, projectPath) => ipcRenderer.invoke('media:read', imgPath, projectPath),
  pickImage: () => ipcRenderer.invoke('media:pick'),
  chooseExportFolder: () => ipcRenderer.invoke('usb:choose-folder'),
  writeExport: (dir, files, remove) => ipcRenderer.invoke('usb:write', dir, files, remove),
  ejectDisk: (dir) => ipcRenderer.invoke('usb:eject', dir),
  readExportSource: (dir) => ipcRenderer.invoke('usb:read-source', dir),
  setDocumentState: (state) => ipcRenderer.send('doc:state', state),
  notifySaved: () => ipcRenderer.send('doc:saved'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, name) => cb(name)),
  platform: process.platform,
});
