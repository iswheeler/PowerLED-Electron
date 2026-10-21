const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerIpc } = require('./ipc');

let win = null;
let docState = { dirty: false, path: null };
let closing = false;

function send(name) {
  win?.webContents.send('menu', name);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 600,
    title: 'PowerLED',
    backgroundColor: '#1b1d21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  win.on('close', (e) => {
    if (closing || !docState.dirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${docState.path ? path.basename(docState.path) : 'untitled'}?`,
      detail: 'Your changes will be lost if you do not save them.',
    });
    if (choice === 2) return;
    if (choice === 1) {
      closing = true;
      win.close();
      return;
    }
    // Save: ask the renderer, then close once it reports the save finished.
    ipcMain.once('doc:saved', () => {
      closing = true;
      win?.close();
    });
    send('save');
  });
  win.on('closed', () => {
    win = null;
  });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const item = (label, accelerator, name) => ({ label, accelerator, click: () => send(name) });
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        item('New Project', 'CmdOrCtrl+N', 'new'),
        item('Open Project…', 'CmdOrCtrl+O', 'open'),
        { type: 'separator' },
        item('Save', 'CmdOrCtrl+S', 'save'),
        item('Save As…', 'CmdOrCtrl+Shift+S', 'save-as'),
        { type: 'separator' },
        item('Export to USB Disk (*.tfu)…', 'CmdOrCtrl+E', 'export-usb'),
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'CmdOrCtrl+Z', 'undo'),
        item('Redo', 'CmdOrCtrl+Shift+Z', 'redo'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        item('Delete Selected Item', 'CmdOrCtrl+Backspace', 'delete'),
        item('Duplicate Selected Item', 'CmdOrCtrl+D', 'duplicate'),
      ],
    },
    {
      label: 'Insert',
      submenu: [
        item('Program', null, 'add-program'),
        item('Window', null, 'add-window'),
        item('Text Page', null, 'add-text'),
        item('Media Page…', null, 'add-media'),
        item('Canvas Page (pixel painting)', null, 'add-canvas'),
      ],
    },
    {
      label: 'Preview',
      submenu: [item('Start / Stop Preview', 'CmdOrCtrl+P', 'toggle-preview')],
    },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, item('Zoom In', 'CmdOrCtrl+Plus', 'zoom-in'), { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', visible: false, click: () => send('zoom-in') },
      item('Zoom Out', 'CmdOrCtrl+-', 'zoom-out'), item('Fit to Window', 'CmdOrCtrl+0', 'zoom-fit'), { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

registerIpc({ getWindow: () => win, setDocState: (s) => { docState = s; } });

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  const arg = process.argv.slice(2).find((a) => a.endsWith('.ledprj'));
  if (arg) win.webContents.once('did-finish-load', () => win.webContents.send('menu', `open-path:${path.resolve(arg)}`));
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
});
