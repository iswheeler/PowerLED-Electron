const { dialog, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ejectDisk } = require('./usb-eject');

const FILTERS = [{ name: 'PowerLED projects', extensions: ['ledprj'] }, { name: 'All files', extensions: ['*'] }];

// getWindow(): the BrowserWindow dialogs attach to; setDocState(state): remembers {dirty, path} for the close prompt.
function registerIpc({ getWindow, setDocState }) {
  const win = () => getWindow();

  ipcMain.on('doc:state', (_e, state) => {
    setDocState(state);
    if (!win()) return;
    const name = state.path ? path.basename(state.path) : 'untitled';
    win().setTitle(`${name}${state.dirty ? ' •' : ''} — PowerLED`);
    win().setDocumentEdited?.(!!state.dirty);
    if (state.path) win().setRepresentedFilename?.(state.path);
  });

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters: FILTERS });
    if (r.canceled || !r.filePaths[0]) return null;
    return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
  });

  ipcMain.handle('project:open-path', (_e, p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));

  ipcMain.handle('project:save', async (_e, { path: p, text, saveAs }) => {
    let target = p;
    if (!target || saveAs) {
      const r = await dialog.showSaveDialog(win(), {
        defaultPath: target ?? 'untitled.ledprj',
        filters: FILTERS,
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath.endsWith('.ledprj') ? r.filePath : `${r.filePath}.ledprj`;
    }
    fs.writeFileSync(target, text, 'utf8');
    return { path: target };
  });

  const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp' };

  // Project files carry Windows paths (C:\users\...\x.png). Look for the file by name next to the
  // project, in an `images` folder beside it, or in the parent's `images` folder.
  function resolveMedia(imgPath, projectPath) {
    const candidates = [imgPath];
    const base = path.basename(String(imgPath).replace(/\\/g, '/'));
    if (projectPath) {
      const dir = path.dirname(projectPath);
      candidates.push(path.join(dir, base), path.join(dir, 'images', base), path.join(dir, '..', 'images', base));
    }
    return candidates.find((c) => {
      try {
        return fs.statSync(c).isFile();
      } catch {
        return false;
      }
    });
  }

  function readImageFile(p) {
    const mime = MIME[path.extname(p).toLowerCase()];
    if (!mime) return null;
    return { resolved: p, dataUrl: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` };
  }

  ipcMain.handle('media:read', (_e, imgPath, projectPath) => {
    if (!imgPath) return null;
    const found = resolveMedia(imgPath, projectPath);
    return found ? readImageFile(found) : null;
  });

  ipcMain.handle('media:pick', async () => {
    const r = await dialog.showOpenDialog(win(), {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return readImageFile(r.filePaths[0]);
  });

  ipcMain.handle('usb:choose-folder', async () => {
    const r = await dialog.showOpenDialog(win(), {
      title: 'Choose the USB disk (or a folder to export into)',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // Writes {relativePath: bytes} under dir, creating folders as needed. `remove` lists *.TFU names inside
  // dir/POWERLED to delete first (stale programs from earlier exports).
  ipcMain.handle('usb:write', (_e, dir, files, remove = []) => {
    const root = path.resolve(dir);
    const removed = [];
    for (const name of remove) {
      if (!/^[^\\/]+\.tfu$/i.test(name)) throw new Error(`Refusing to delete ${name}`);
      const target = path.join(root, 'POWERLED', name);
      if (fs.existsSync(target)) {
        fs.unlinkSync(target);
        removed.push(target);
      }
    }
    const written = [];
    for (const [rel, bytes] of Object.entries(files)) {
      const target = path.resolve(root, rel);
      if (!target.startsWith(root + path.sep)) throw new Error(`Refusing to write outside ${dir}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(bytes));
      written.push(target);
    }
    return { written, removed };
  });

  ipcMain.handle('usb:eject', (_e, dir) => ejectDisk(dir));

  // What is already on the disk: the controller's own LED.TFR (panel parameters) and any existing *.TFU programs.
  ipcMain.handle('usb:read-source', (_e, dir) => {
    const tfrPath = path.join(dir, 'LED.TFR');
    const progDir = path.join(dir, 'POWERLED');
    let existing = [];
    try {
      existing = fs.readdirSync(progDir).filter((f) => /\.tfu$/i.test(f));
    } catch { /* no POWERLED folder yet */ }
    return { tfr: fs.existsSync(tfrPath) ? Array.from(fs.readFileSync(tfrPath)) : null, existing };
  });
}

module.exports = { registerIpc };
