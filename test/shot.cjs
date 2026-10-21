// Dev harness: electron test/shot.cjs <project.ledprj|-> <out.png> [js to run before the shot] [delay ms]
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [proj, out, js = '', delay = '1200'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const { registerIpc } = require('../ipc');
let win = null;
// Dialogs auto-answer: the folder picker returns $SHOT_DIR, image picker nothing.
const { dialog } = require('electron');
dialog.showOpenDialog = async () => (process.env.SHOT_DIR ? { canceled: false, filePaths: [process.env.SHOT_DIR] } : { canceled: true, filePaths: [] });
registerIpc({ getWindow: () => win, setDocState: () => {} });

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 1360, height: 860, show: false, webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg, line, src) => { if (level >= 2) errors.push(`${msg} (${path.basename(src)}:${line})`); });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render gone ' + d.reason));
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  if (proj !== '-') win.webContents.send('menu', `open-path:${path.resolve(proj)}`);
  await wait(700);
  if (js) {
    const r = await win.webContents.executeJavaScript(js).catch((e) => 'JS ERROR: ' + e.message);
    if (r !== undefined) console.log('js ->', typeof r === 'string' ? r : JSON.stringify(r));
  }
  if (process.env.SHOT_MAIN_JS) {
    // run in the main process (access to `win`), e.g. to exercise native copy/paste like the Edit menu does
    const r = await eval(`(async () => { ${process.env.SHOT_MAIN_JS} })()`);
    if (r !== undefined) console.log('main ->', r);
  }
  await wait(+delay);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('errors:', errors.length ? '\n' + errors.join('\n') : 'none');
  app.quit();
});
