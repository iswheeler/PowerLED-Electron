import {
  T, ACTIONS, COLOR_TYPES, WEEK_DAYS, PICTURE_POSITIONS, VERTICAL_ALIGN, PAGE_TYPE_NAMES,
  parseProject, serializeProject, newProject, newProgram, newWindow, newText, newMedia, newCanvas,
  panels, panelSize, panelColorType, setPanelSize, windowRect, formatRect, colorRefToRgb, rgbToColorRef, rgbToHex, hexToRgb,
  dayNumberToDate, dateToDayNumber, isUnlimited, pageKind,
} from './project.js';
import { parseRtf, generateRtf, summary, DEFAULT_FS } from './rtf.js';
import { Player, renderStaticProgram, drawLedPanel, rasterizePageForExport, quantizeToPlanes } from './render.js';
import { buildUsbExport, configFromTfr, collectPrograms } from './usb.js';

// ---------------------------------------------------------------------------------------------
// DOM helpers

const $ = (sel) => document.querySelector(sel);
const treeEl = $('#tree');
const inspEl = $('#inspector');
const ledEl = $('#led');
const overlayEl = $('#overlay');
const stageTitle = $('#stageTitle');
const stageHint = $('#stageHint');
const statusMsg = $('#statusMsg');
const statusInfo = $('#statusInfo');
const zoomEl = $('#zoom');

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected', 'textContent', 'innerHTML'].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) e.append(kid?.nodeType ? kid : document.createTextNode(kid ?? ''));
  return e;
}

let statusTimer = 0;
function status(msg, ms = 4000) {
  statusMsg.textContent = msg;
  clearTimeout(statusTimer);
  if (ms) statusTimer = setTimeout(() => (statusMsg.textContent = 'Ready'), ms);
}

function dialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }] }) {
  const dlg = $('#dlg');
  dlg.replaceChildren(
    h('h3', {}, title),
    typeof body === 'string' ? h('div', { innerHTML: body }) : body,
    h('div', { class: 'actions' }, buttons.map((b) =>
      h('button', { class: b.primary ? 'accent' : '', onclick: () => dlg.close(String(b.value)) }, b.label))),
  );
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const raw = dlg.returnValue;
      const hit = buttons.find((b) => String(b.value) === raw);
      resolve(hit ? hit.value : null);
    }, { once: true });
    dlg.returnValue = '';
    dlg.showModal();
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------------------------------------
// State

const state = {
  project: newProject(),
  filePath: null,
  sel: null, // selected tree node
  collapsed: new Set(),
  previewing: false,
};
state.sel = panels(state.project)[0];

function ancestors(node, root = state.project.root, trail = []) {
  if (root === node) return [...trail, root];
  for (const c of root.children) {
    const r = ancestors(node, c, [...trail, root]);
    if (r) return r;
  }
  return null;
}

function context() {
  const chain = ancestors(state.sel) ?? [state.project.root];
  const of = (long) => chain.find((n) => n.long === long) ?? null;
  const panel = of(T.PANEL) ?? panels(state.project)[0] ?? null;
  const program = of(T.PROGRAM);
  const win = of(T.WINDOW);
  const sel = state.sel;
  const page = sel && ![T.ROOT, T.PANEL, T.PROGRAM, T.WINDOW].includes(sel.long) ? sel : null;
  return { chain, panel, program, win, page };
}

function pathOf(node) {
  const chain = ancestors(node);
  if (!chain) return [];
  return chain.slice(1).map((n, i) => chain[i].children.indexOf(n));
}
function nodeAt(path, root = state.project.root) {
  let n = root;
  for (const i of path) n = n?.children[i];
  return n ?? null;
}

// ---------------------------------------------------------------------------------------------
// Undo / redo and dirty tracking (snapshots of the serialised project)

const history = { undo: [], redo: [], text: '', sel: [], savedText: '', lastKey: null, lastTime: 0 };

function resetHistory() {
  history.text = serializeProject(state.project);
  history.savedText = history.text;
  history.sel = pathOf(state.sel);
  history.undo = [];
  history.redo = [];
  history.lastKey = null;
  reportDocState();
}

function commit(key = null) {
  const text = serializeProject(state.project);
  if (text === history.text) return;
  const now = performance.now();
  const coalesce = key && key === history.lastKey && now - history.lastTime < 1000 && history.undo.length;
  if (!coalesce) history.undo.push({ text: history.text, sel: history.sel });
  if (history.undo.length > 200) history.undo.shift();
  history.text = text;
  history.sel = pathOf(state.sel);
  history.redo = [];
  history.lastKey = key;
  history.lastTime = now;
  reportDocState();
}

function restore(entry) {
  selection = null;
  const keep = pathOf(state.sel); // stay on the item being worked on when it still exists
  state.project = parseProject(entry.text);
  state.sel = nodeAt(keep) ?? nodeAt(entry.sel) ?? panels(state.project)[0];
  history.text = entry.text;
  history.sel = entry.sel;
  history.lastKey = null;
  refreshAll();
  reportDocState();
}

function undo() {
  const e = history.undo.pop();
  if (!e) return status('Nothing to undo');
  history.redo.push({ text: history.text, sel: history.sel });
  restore(e);
}

function redo() {
  const e = history.redo.pop();
  if (!e) return status('Nothing to redo');
  history.undo.push({ text: history.text, sel: history.sel });
  restore(e);
}

const isDirty = () => history.text !== history.savedText;

function reportDocState() {
  window.api.setDocumentState({ dirty: isDirty(), path: state.filePath });
}

// ---------------------------------------------------------------------------------------------
// Images (project files reference Windows paths; main resolves them on this machine)

const images = new Map();

function getImage(path) {
  if (!path) return null;
  if (path.startsWith('data:')) { // inline canvas pixels
    const hit = images.get(path);
    if (hit) return hit.img ?? null;
    images.set(path, { img: null });
    const img = new Image();
    img.onload = () => { images.set(path, { img }); renderStage(); if (state.previewing) startPreview(); };
    img.src = path;
    return null;
  }
  const key = `${state.filePath ?? ''}|${path}`;
  const hit = images.get(key);
  if (hit) return hit.img ?? null;
  images.set(key, { img: null });
  window.api.readImage(path, state.filePath).then((r) => {
    if (!r) return;
    const img = new Image();
    img.onload = () => {
      images.set(key, { img, resolved: r.resolved });
      renderStage();
      if (state.previewing) startPreview();
    };
    img.src = r.dataUrl;
  });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Tree

function pageLabel(n) {
  const kind = pageKind(n);
  if (kind === 'text') return n.get('sm') || '(empty)';
  if (kind === 'media') return n.get('ip04').split(/[\\/]/).pop() || '(no file)';
  if (kind === 'canvas') return 'pixel canvas';
  return n.great;
}

function renderTree() {
  const keepScroll = treeEl.scrollTop;
  treeEl.replaceChildren();
  const walk = (n, depth) => {
    const isPanel = n.long === T.PANEL;
    const isProgram = n.long === T.PROGRAM;
    const isWindow = n.long === T.WINDOW;
    const hasKids = n.children.length > 0;
    let kind;
    let label;
    if (isPanel) { kind = 'Panel'; const s = panelSize(n); label = `${n.great}  ${s.width}×${s.height}`; }
    else if (isProgram) { kind = 'Prog'; label = n.great; }
    else if (isWindow) { const r = windowRect(n); kind = 'Win'; label = `${r.w}×${r.h} @ ${r.x},${r.y}`; }
    else { kind = pageKind(n) === 'canvas' ? 'Canvas' : (PAGE_TYPE_NAMES[n.long] ?? `Type ${n.long}`).split('/')[0]; label = pageLabel(n); }

    const row = h('div', {
      class: `node${n === state.sel ? ' sel' : ''}${(isPanel || isProgram) && !n.enabled ? ' off' : ''}`,
      style: `padding-left:${8 + depth * 16}px`,
      onclick: () => select(n),
    },
    h('span', {
      class: 'twisty',
      onclick: (e) => {
        e.stopPropagation();
        if (state.collapsed.has(n)) state.collapsed.delete(n); else state.collapsed.add(n);
        renderTree();
      },
    }, hasKids ? (state.collapsed.has(n) ? '▸' : '▾') : ''),
    (isPanel || isProgram) ? h('input', {
      type: 'checkbox',
      checked: n.enabled,
      title: 'Include in preview and export',
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => { n.enabled = e.target.checked; afterEdit('enable'); },
    }) : null,
    h('span', { class: 'kind' }, kind),
    h('span', { class: 'label' }, label));
    row.__node = n;
    treeEl.append(row);
    if (hasKids && !state.collapsed.has(n)) for (const c of n.children) walk(c, depth + 1);
  };
  for (const p of state.project.root.children) walk(p, 0);
  treeEl.scrollTop = keepScroll;
}

function select(n) {
  state.sel = n;
  renderTree();
  renderInspector();
  renderStage();
  if (state.previewing) startPreview();
}

// ---------------------------------------------------------------------------------------------
// Inspector

function row(label, ...ctl) {
  return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'ctl' }, ctl));
}

function textInput(get, set, opts = {}) {
  return h('input', { type: 'text', value: get(), ...opts, oninput: (e) => set(e.target.value) });
}

function numInput(get, set, { min, max, step = 1 } = {}) {
  return h('input', {
    type: 'number', value: get(), min, max, step,
    oninput: (e) => {
      const v = parseFloat(e.target.value);
      if (!Number.isNaN(v)) set(v);
    },
  });
}

function selectInput(options, get, set) {
  const cur = get();
  return h('select', { onchange: (e) => set(parseInt(e.target.value, 10)) },
    options.map((o, i) => h('option', { value: i, selected: i === cur }, o)));
}

function colorInput(getRgb, setRgb) {
  return h('input', { type: 'color', value: rgbToHex(getRgb()), oninput: (e) => setRgb(hexToRgb(e.target.value)) });
}

function checkbox(get, set, label) {
  return h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: get(), onchange: (e) => set(e.target.checked) }), label);
}

function renderInspector() {
  const ctx = context();
  const n = state.sel;
  inspEl.replaceChildren();
  if (!n || n.long === T.ROOT) {
    inspEl.append(h('div', { class: 'insp note' }, 'Select an item in the tree.'));
    return;
  }
  const box = h('div', { class: 'insp' });
  inspEl.append(box);

  switch (n.long) {
    case T.PANEL: inspectPanel(box, n); break;
    case T.PROGRAM: inspectProgram(box, n); break;
    case T.WINDOW: inspectWindow(box, n); break;
    default: inspectPage(box, n, ctx);
  }
}

function inspectPanel(box, n) {
  const size = panelSize(n);
  box.append(
    h('h3', {}, 'Panel'),
    row('Name', textInput(() => n.great, (v) => { n.great = v; afterEdit('panel-name'); })),
    h('h4', {}, 'Screen'),
    row('Width (px)', numInput(() => size.width, (v) => { size.width = v; setPanelSize(n, size.width, size.height); afterEdit('panel-size', true); }, { min: 1, max: 4096 })),
    row('Height (px)', numInput(() => size.height, (v) => { size.height = v; setPanelSize(n, size.width, size.height); afterEdit('panel-size', true); }, { min: 1, max: 1024 })),
    row('Color', selectInput(COLOR_TYPES, () => panelColorType(n) - 1, (v) => { n.set('pc', v + 1); afterEdit('panel-color'); })),
    h('p', { class: 'note' }, 'Controller, scan and network parameters in the file are preserved untouched.'),
  );
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first, as in the original dialog

function inspectProgram(box, n) {
  const sd = n.int('sd');
  const ed = n.int('ed');
  const st = n.int('st');
  const et = n.int('et');
  const mode = n.int('pt', 0);
  const toTime = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}`;
  const fromTime = (v) => { const [a = 0, b = 0] = v.split(':').map(Number); return a * 3600 + b * 60; };
  const iso = (days) => dayNumberToDate(days & 0x7fffffff).toISOString().slice(0, 10);
  const wk = n.int('wk', 255);

  const dateOn = !isUnlimited(sd);
  const timeOn = !isUnlimited(st);
  const dateStart = h('input', { type: 'date', value: iso(sd), disabled: !dateOn, onchange: (e) => writeDates() });
  const dateEnd = h('input', { type: 'date', value: iso(ed), disabled: !dateOn, onchange: (e) => writeDates() });
  const dateChk = h('input', { type: 'checkbox', checked: dateOn, onchange: () => { dateStart.disabled = dateEnd.disabled = !dateChk.checked; writeDates(); } });
  const timeStart = h('input', { type: 'time', value: toTime(st & 0x7fffffff), disabled: !timeOn, onchange: () => writeTimes() });
  const timeEnd = h('input', { type: 'time', value: toTime(et), disabled: !timeOn, onchange: () => writeTimes() });
  const timeChk = h('input', { type: 'checkbox', checked: timeOn, onchange: () => { timeStart.disabled = timeEnd.disabled = !timeChk.checked; writeTimes(); } });

  function writeDates() {
    const s = dateToDayNumber(new Date(`${dateStart.value || '2000-01-01'}T00:00:00`));
    const e = dateToDayNumber(new Date(`${dateEnd.value || '2000-01-01'}T00:00:00`));
    n.set('sd', dateChk.checked ? s : (0x80000000 | s) | 0);
    n.set('ed', e);
    afterEdit('program-dates');
  }
  function writeTimes() {
    const s = fromTime(timeStart.value);
    n.set('st', timeChk.checked ? s : (0x80000000 | s) | 0);
    n.set('et', fromTime(timeEnd.value));
    afterEdit('program-times');
  }

  const timeSec = numInput(() => n.int('time', 60), (v) => { n.set('time', Math.max(1, Math.round(v))); afterEdit('program-time'); }, { min: 1, max: 86400 });
  timeSec.disabled = mode !== 1;

  box.append(
    h('h3', {}, 'Program'),
    row('Name', textInput(() => n.great, (v) => { n.great = v; afterEdit('prog-name'); })),
    row('', checkbox(() => n.enabled, (v) => { n.enabled = v; afterEdit('enable'); }, 'Include in preview / export')),
    h('h4', {}, 'Play'),
    row('Play mode', selectInput(['Default (order)', 'Timing'], () => mode, (v) => { n.set('pt', v); timeSec.disabled = v !== 1; afterEdit('program-mode'); })),
    row('Duration (s)', timeSec),
    h('h4', {}, 'Schedule'),
    row('Date range', dateChk, dateStart, h('span', {}, '→'), dateEnd),
    row('Time of day', timeChk, timeStart, h('span', {}, '→'), timeEnd),
    row('Week', h('div', { class: 'days' }, WEEK_ORDER.map((d, i) => h('label', {},
      h('input', {
        type: 'checkbox',
        checked: !!(wk & (1 << i)),
        onchange: (e) => { n.set('wk', e.target.checked ? n.int('wk', 255) | (1 << i) : n.int('wk', 255) & ~(1 << i)); afterEdit('program-week'); },
      }), WEEK_DAYS[d].slice(0, 3))))),
    h('p', { class: 'note' }, 'Schedule bits follow the stock dialog order (Mon … Sun).'),
  );
}

function inspectWindow(box, n) {
  const r = windowRect(n);
  const apply = () => { n.set('rect', formatRect(r)); afterEdit('window-rect'); };
  const mk = (key, opts) => numInput(() => r[key], (v) => { r[key] = Math.round(v); apply(); }, opts);
  const rectInputs = { x: mk('x', { min: 0 }), y: mk('y', { min: 0 }), w: mk('w', { min: 1 }), h: mk('h', { min: 1 }) };
  for (const [k, el] of Object.entries(rectInputs)) el.dataset.rect = k;
  box.append(
    h('h3', {}, 'Window'),
    h('p', { class: 'note' }, 'A window is a rectangular zone on the panel. Drag it on the preview, or type exact coordinates.'),
    row('X', rectInputs.x), row('Y', rectInputs.y), row('Width', rectInputs.w), row('Height', rectInputs.h),
  );
}

function syncRectInputs(r) {
  for (const el of inspEl.querySelectorAll('input[data-rect]')) el.value = r[el.dataset.rect];
}

function inspectPage(box, n, ctx) {
  const kind = pageKind(n);
  const title = kind === 'canvas' ? 'Canvas' : (PAGE_TYPE_NAMES[n.long] ?? `Page type ${n.long}`);
  box.append(
    h('h3', {}, `${title} page`),
    row('Name', textInput(() => n.great, (v) => { n.great = v; afterEdit('page-name'); })),
    row('', checkbox(() => n.enabled, (v) => { n.enabled = v; afterEdit('enable'); }, 'Show this page')),
  );

  if (kind === 'text') buildTextSection(box, n);
  else if (kind === 'media') buildMediaSection(box, n);
  else if (kind === 'canvas') buildCanvasSection(box, n, ctx);
  else box.append(h('p', { class: 'note warn' }, `${title} pages can't be edited in this version. They are kept as-is when you save, and shown approximately in the preview.`));

  const holdSec = () => n.int('delay', 100) / 100;
  box.append(
    h('h4', {}, 'Effect'),
    row('Entry effect', selectInput(ACTIONS, () => n.int('action', 1), (v) => { n.set('action', v); afterEdit('page-action'); })),
    row('Speed', numInput(() => n.int('speed', 1), (v) => { n.set('speed', Math.max(1, Math.min(16, Math.round(v)))); afterEdit('page-speed'); }, { min: 1, max: 16 }),
      h('span', { class: 'note' }, '1 = fastest')),
    row('Hold (s)', numInput(holdSec, (v) => { n.set('delay', Math.max(0, Math.round(v * 100))); afterEdit('page-delay'); }, { min: 0, max: 600, step: 0.1 })),
    row('Clear', selectInput(['None', 'Clear direct'], () => n.int('clear', 0), (v) => { n.set('clear', v); afterEdit('page-clear'); })),
  );
}

// -------- text page

const FONTS = ['Arial', 'Tahoma', 'Verdana', 'Times New Roman', 'Courier New', 'Georgia', 'Trebuchet MS', 'Impact', 'Comic Sans MS', 'System', 'SimSun', 'Microsoft YaHei'];
const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72];
const ptToPx = (pt) => (pt * 96) / 72;

function docToHtml(doc) {
  const align = { l: 'left', c: 'center', r: 'right' };
  return doc.paras.map((p) => {
    const inner = p.runs.length ? p.runs.map((r) => {
      const style = [
        r.color ? `color:rgb(${r.color.join(',')})` : '',
        r.b ? 'font-weight:bold' : '',
        r.i ? 'font-style:italic' : '',
        r.u ? 'text-decoration:underline' : '',
        `font-size:${ptToPx((r.fs ?? DEFAULT_FS) / 2)}px`,
        r.font ? `font-family:"${r.font}"` : '',
      ].filter(Boolean).join(';');
      return `<span style='${style.replace(/'/g, '')}'>${esc(r.text).replace(/\n/g, '<br>')}</span>`;
    }).join('') : '<br>';
    return `<div style="text-align:${align[p.align] ?? 'left'}">${inner}</div>`;
  }).join('') || '<div><br></div>';
}

function parseCssColor(s) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s);
  return m ? [+m[1], +m[2], +m[3]] : null;
}

// DOM -> document model, using computed styles so execCommand output (spans, <b>, <font>) all work.
function editorToDoc(root) {
  const paras = [];
  let cur = null;
  const startPara = (blockEl) => {
    const ta = getComputedStyle(blockEl).textAlign;
    cur = { align: ta === 'center' ? 'c' : ta === 'right' || ta === 'end' ? 'r' : 'l', runs: [] };
    paras.push(cur);
  };
  const addText = (text, el) => {
    if (!text) return;
    const cs = getComputedStyle(el);
    let underline = false;
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) {
      if (getComputedStyle(e).textDecorationLine.includes('underline')) underline = true;
    }
    const run = {
      text,
      b: parseInt(cs.fontWeight, 10) >= 600 || cs.fontWeight === 'bold',
      i: cs.fontStyle === 'italic',
      u: underline,
      color: parseCssColor(cs.color),
      fs: Math.round(parseFloat(cs.fontSize) * 0.75 * 2),
      font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(),
    };
    const last = cur.runs[cur.runs.length - 1];
    if (last && ['b', 'i', 'u', 'fs', 'font'].every((k) => last[k] === run[k]) && JSON.stringify(last.color) === JSON.stringify(run.color)) last.text += text;
    else cur.runs.push(run);
  };
  const isBlock = (el) => ['DIV', 'P', 'LI'].includes(el.tagName);
  const walk = (node, blockEl) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) {
        if (!cur) startPara(blockEl);
        addText(c.textContent.replace(/​/g, ''), c.parentElement);
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        if (c.tagName === 'BR') {
          // a lone <br> in an empty block is just that block's placeholder
          const onlyChild = c.parentElement.childNodes.length === 1;
          if (!onlyChild) {
            if (!cur) startPara(blockEl);
            addText('\n', c.parentElement);
          }
        } else if (isBlock(c)) {
          cur = null;
          startPara(c);
          walk(c, c);
          cur = null;
        } else walk(c, blockEl);
      }
    }
  };
  walk(root, root);
  return { paras };
}

function buildTextSection(box, n) {
  const doc = parseRtf(n.get('rtf'));
  const editor = h('div', { id: 'rtEditor', contenteditable: 'true', spellcheck: 'false', innerHTML: docToHtml(doc) });
  const bg = () => rgbToHex(colorRefToRgb(n.int('bkcr', 0)));
  const paintBg = () => { editor.style.background = bg(); editor.style.color = '#fff'; };
  paintBg();

  let timer = 0;
  const sync = () => {
    const d = editorToDoc(editor);
    n.set('rtf', generateRtf(d));
    n.set('sm', summary(d));
    afterEdit(`rtf:${pathOf(n).join('.')}`);
  };
  editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(sync, 150); });
  editor.addEventListener('blur', () => { clearTimeout(timer); });

  const exec = (cmd, val) => {
    editor.focus();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, val);
    clearTimeout(timer);
    sync();
  };
  const toggle = (label, cmd, title, style = '') => h('button', { title, style, onmousedown: (e) => e.preventDefault(), onclick: () => exec(cmd) }, label);

  const fonts = [...new Set([...FONTS, ...doc.paras.flatMap((p) => p.runs.map((r) => r.font)).filter(Boolean)])];
  const fontSel = h('select', { title: 'Font', onchange: (e) => { exec('fontName', e.target.value); e.target.value = ''; } },
    h('option', { value: '' }, 'Font…'), fonts.map((f) => h('option', { value: f }, f)));
  const sizeSel = h('select', {
    title: 'Size (pt)',
    onchange: (e) => {
      const pt = parseFloat(e.target.value);
      e.target.value = '';
      if (!pt) return;
      editor.focus();
      document.execCommand('styleWithCSS', false, true);
      document.execCommand('fontSize', false, '7');
      for (const el of editor.querySelectorAll('font[size="7"], span[style*="xxx-large"]')) {
        el.removeAttribute('size');
        el.style.fontSize = `${ptToPx(pt)}px`;
      }
      clearTimeout(timer);
      sync();
    },
  }, h('option', { value: '' }, 'Size…'), SIZES.map((s) => h('option', { value: s }, `${s} pt`)));
  const colorPick = h('input', { type: 'color', title: 'Text color', value: '#ff0000', oninput: (e) => exec('foreColor', e.target.value) });

  box.append(
    h('h4', {}, 'Text'),
    h('div', { class: 'rt-toolbar' },
      toggle('B', 'bold', 'Bold', 'font-weight:bold'), toggle('I', 'italic', 'Italic', 'font-style:italic'), toggle('U', 'underline', 'Underline', 'text-decoration:underline'),
      toggle('⇤', 'justifyLeft', 'Align left'), toggle('↔', 'justifyCenter', 'Center'), toggle('⇥', 'justifyRight', 'Align right'),
      fontSel, sizeSel, colorPick),
    editor,
    h('p', { class: 'note' }, 'Text that is taller than the window flows onto extra pages; continuous-move effects lay it out on one line.'),
    h('h4', {}, 'Page'),
    row('Background', colorInput(() => colorRefToRgb(n.int('bkcr', 0)), (rgb) => { n.set('bkcr', rgbToColorRef(rgb)); paintBg(); afterEdit('page-bg'); })),
    row('Vertical align', selectInput(VERTICAL_ALIGN, () => n.int('va', 1), (v) => { n.set('va', v); afterEdit('page-va'); })),
    row('Line gap (px)', numInput(() => n.int('line', 0), (v) => { n.set('line', Math.max(0, Math.round(v))); afterEdit('page-line'); }, { min: 0, max: 64 })),
  );
}

// -------- media page

function buildMediaSection(box, n) {
  const pathInput = textInput(() => n.get('ip04'), (v) => { n.set('ip04', v); afterEdit('media-path'); }, { spellcheck: 'false' });
  const info = h('p', { class: 'note' });
  const updateInfo = () => {
    const hit = images.get(`${state.filePath ?? ''}|${n.get('ip04')}`);
    info.className = hit?.img ? 'note' : 'note warn';
    info.textContent = hit?.img
      ? `${hit.img.naturalWidth}×${hit.img.naturalHeight} px — ${hit.resolved}`
      : 'File not found on this computer. The original path is kept; use Browse… to relink.';
  };
  getImage(n.get('ip04'));
  setTimeout(updateInfo, 80);
  box.append(
    h('h4', {}, 'Image'),
    row('File', pathInput, h('button', {
      onclick: async () => {
        const r = await window.api.pickImage();
        if (!r) return;
        n.set('ip04', r.resolved);
        const img = new Image();
        img.onload = () => {
          images.set(`${state.filePath ?? ''}|${r.resolved}`, { img, resolved: r.resolved });
          pathInput.value = r.resolved;
          afterEdit('media-path');
          updateInfo();
        };
        img.src = r.dataUrl;
      },
    }, 'Browse…')),
    info,
    row('Position', selectInput(PICTURE_POSITIONS, () => n.int('ip01', 0), (v) => { n.set('ip01', v); afterEdit('media-pos'); })),
    row('Fill color', colorInput(() => colorRefToRgb(n.int('bkcr', 0)), (rgb) => { n.set('bkcr', rgbToColorRef(rgb)); afterEdit('media-bg'); })),
    h('h4', {}, 'Remove color'),
    row('Color', colorInput(() => colorRefToRgb(n.int('ip00', 0xfafafa)), (rgb) => { n.set('ip00', rgbToColorRef(rgb)); afterEdit('media-key'); })),
    row('Limit', numInput(() => n.int('ip02', 10), (v) => { n.set('ip02', Math.round(v)); afterEdit('media-limit'); }, { min: 0, max: 255 })),
    row('Range', numInput(() => n.int('ip03', 5), (v) => { n.set('ip03', Math.round(v)); afterEdit('media-range'); }, { min: 0, max: 255 })),
    h('p', { class: 'note' }, 'The remove-color values are stored in the project; the preview shows the image as-is.'),
  );
}


// -------- canvas page (pixel painting; behaves like an image for the sign)

const paint = { tool: 'pencil', color: [255, 0, 0] };

function paletteFor(panel) {
  const planes = panelColorType(panel);
  const all = [['Red', [255, 0, 0]], ['Green', [0, 255, 0]], ['Yellow', [255, 255, 0]], ['Blue', [0, 0, 255]], ['Magenta', [255, 0, 255]], ['Cyan', [0, 255, 255]], ['White', [255, 255, 255]]];
  if (planes <= 1) return all.slice(0, 1);
  if (planes === 2) return all.slice(0, 3);
  return all;
}

const newCanvasEl = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#000';
  x.fillRect(0, 0, c.width, c.height);
  return c;
};

const pngBase64 = (canvas) => canvas.toDataURL('image/png').split(',')[1];

// Writes the working canvas back into the page and seeds the image cache so the stage updates synchronously.
function storeCanvas(page, canvas) {
  const b64 = pngBase64(canvas);
  page.set('cvpng', b64);
  const snap = newCanvasEl(canvas.width, canvas.height);
  snap.getContext('2d').drawImage(canvas, 0, 0);
  images.set(`data:image/png;base64,${b64}`, { img: snap });
}

function currentCanvasPixels(page) {
  const img = getImage(`data:image/png;base64,${page.get('cvpng')}`);
  if (!img) return null;
  const c = newCanvasEl(img.width, img.height);
  c.getContext('2d').drawImage(img, 0, 0);
  return c;
}

function floodFill(canvas, x, y, rgb) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const at = (px, py) => (py * w + px) * 4;
  const t = at(x, y);
  const from = [d[t], d[t + 1], d[t + 2]];
  if (from[0] === rgb[0] && from[1] === rgb[1] && from[2] === rgb[2]) return;
  const stack = [[x, y]];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const i = at(px, py);
    if (d[i] !== from[0] || d[i + 1] !== from[1] || d[i + 2] !== from[2]) continue;
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2];
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  ctx.putImageData(img, 0, 0);
}

function plotLine(ctx, x0, y0, x1, y1) { // Bresenham, one LED wide
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// ---- selection state (rectangle on the canvas page being edited)
let selection = null; // { page, x, y, w, h }
let pixelClipboard = null; // canvas holding copied pixels

const copyCanvas = (src) => {
  const c = newCanvasEl(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
};

function activeCanvasPage() {
  const { page } = context();
  return page && pageKind(page) === 'canvas' ? page : null;
}

const hasSelection = (page) => !!selection && selection.page === page && selection.w > 0 && selection.h > 0;

function clipRectTo(canvas, r) {
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  return { x, y, w: Math.max(0, Math.min(canvas.width, r.x + r.w) - x), h: Math.max(0, Math.min(canvas.height, r.y + r.h) - y) };
}

// Runs fn(canvas) on the page's pixels, stores the result and records one undo step.
function editPixels(page, key, fn) {
  const canvas = currentCanvasPixels(page);
  if (!canvas) return status('Canvas is still loading…');
  fn(canvas);
  storeCanvas(page, canvas);
  afterEdit(`${key}:${performance.now()}`);
  renderInspector();
}

function selFill(page, rgb = paint.color) {
  if (!hasSelection(page)) return;
  editPixels(page, 'canvas-fill-sel', (c) => {
    const r = clipRectTo(c, selection);
    const x = c.getContext('2d');
    x.fillStyle = `rgb(${rgb.join(',')})`;
    x.fillRect(r.x, r.y, r.w, r.h);
  });
}

const selClear = (page) => selFill(page, [0, 0, 0]);

function selCopy(page) {
  if (!hasSelection(page)) return false;
  const c = currentCanvasPixels(page);
  if (!c) return false;
  const r = clipRectTo(c, selection);
  pixelClipboard = newCanvasEl(Math.max(1, r.w), Math.max(1, r.h));
  pixelClipboard.getContext('2d').drawImage(c, -r.x, -r.y);
  status(`Copied ${r.w}×${r.h} pixels`);
  return true;
}

function selCut(page) {
  if (selCopy(page)) selClear(page);
}

function selPaste(page) {
  if (!pixelClipboard) return status('Nothing copied yet');
  const at = hasSelection(page) ? { x: selection.x, y: selection.y } : { x: 0, y: 0 };
  editPixels(page, 'canvas-paste', (c) => c.getContext('2d').drawImage(pixelClipboard, at.x, at.y));
  selection = { page, x: at.x, y: at.y, w: pixelClipboard.width, h: pixelClipboard.height };
  renderStage();
  renderInspector();
}

function selAll(page) {
  const c = currentCanvasPixels(page);
  if (!c) return;
  selection = { page, x: 0, y: 0, w: c.width, h: c.height };
  renderStage();
  renderInspector();
}

function deselect() {
  if (!selection) return;
  selection = null;
  renderStage();
  renderInspector();
}

const TOOL_KEYS = { p: 'pencil', e: 'eraser', f: 'fill', s: 'select' };

function setTool(tool) {
  paint.tool = tool;
  if (tool !== 'select') selection = null;
  renderInspector();
  renderStage();
}

// Left button paints (or acts as the selected tool), right button always erases.
function startCanvasPointer(e, page, geom) {
  e.preventDefault();
  const canvas = currentCanvasPixels(page);
  if (!canvas) return status('Canvas is still loading…');
  const ox = Math.round((geom.w - canvas.width) / 2);
  const oy = Math.round((geom.h - canvas.height) / 2);
  const toPixel = (ev) => [Math.floor((ev.clientX - geom.left) / pitch) - ox, Math.floor((ev.clientY - geom.top) / pitch) - oy];
  const inside = ([x, y]) => x >= 0 && y >= 0 && x < canvas.width && y < canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rightClick = e.button === 2;

  if (paint.tool === 'select') {
    if (rightClick) { deselect(); return; }
    startSelectDrag(e, page, canvas, toPixel);
    return;
  }

  const erase = rightClick || paint.tool === 'eraser';
  const rgb = erase ? [0, 0, 0] : paint.color;
  ctx.fillStyle = `rgb(${rgb.join(',')})`;
  let last = toPixel(e);
  let changed = false;
  let queued = false;
  const flush = () => {
    queued = false;
    storeCanvas(page, canvas);
    renderStage();
  };
  const apply = (from, to) => {
    if (paint.tool === 'fill') {
      if (inside(to)) { floodFill(canvas, to[0], to[1], rgb); changed = true; }
    } else if (inside(from) || inside(to)) {
      plotLine(ctx, from[0], from[1], to[0], to[1]);
      changed = true;
    }
    if (changed && !queued) { queued = true; requestAnimationFrame(flush); }
  };
  apply(last, last);
  if (paint.tool === 'fill') {
    flush();
    commit(`paint:${performance.now()}`);
    afterEditSoft();
    return;
  }
  const move = (ev) => { const p = toPixel(ev); apply(last, p); last = p; };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (changed) { storeCanvas(page, canvas); commit(`paint:${performance.now()}`); }
    afterEditSoft();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Select tool: drag on empty space to select; drag inside the selection to move it (Alt/Ctrl/Cmd = copy).
function startSelectDrag(e, page, canvas, toPixel) {
  const p0 = toPixel(e);
  const clampPx = ([x, y]) => [Math.max(0, Math.min(canvas.width - 1, x)), Math.max(0, Math.min(canvas.height - 1, y))];
  const inSel = hasSelection(page) && p0[0] >= selection.x && p0[0] < selection.x + selection.w && p0[1] >= selection.y && p0[1] < selection.y + selection.h;

  if (inSel) {
    const copying = e.altKey || e.ctrlKey || e.metaKey;
    const orig = copyCanvas(canvas);
    const r0 = clipRectTo(canvas, selection);
    const grab = newCanvasEl(Math.max(1, r0.w), Math.max(1, r0.h));
    grab.getContext('2d').drawImage(orig, -r0.x, -r0.y);
    const ctx = canvas.getContext('2d');
    let moved = false;
    const move = (ev) => {
      const p = toPixel(ev);
      const dx = p[0] - p0[0], dy = p[1] - p0[1];
      if (!dx && !dy && !moved) return;
      moved = true;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(orig, 0, 0);
      if (!copying) { ctx.fillStyle = '#000'; ctx.fillRect(r0.x, r0.y, r0.w, r0.h); }
      ctx.drawImage(grab, r0.x + dx, r0.y + dy);
      selection = { page, x: r0.x + dx, y: r0.y + dy, w: r0.w, h: r0.h };
      storeCanvas(page, canvas);
      renderStage();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) { commit(`canvas-move:${performance.now()}`); afterEditSoft(); }
      renderInspector();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return;
  }

  const start = clampPx(p0);
  selection = { page, x: start[0], y: start[1], w: 1, h: 1 };
  renderStage();
  const move = (ev) => {
    const p = clampPx(toPixel(ev));
    selection = {
      page, x: Math.min(start[0], p[0]), y: Math.min(start[1], p[1]),
      w: Math.abs(p[0] - start[0]) + 1, h: Math.abs(p[1] - start[1]) + 1,
    };
    renderStage();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    renderInspector();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function buildCanvasSection(box, n, ctx) {
  const panel = ctx.panel;
  const winRect = ctx.win ? windowRect(ctx.win) : { w: 0, h: 0 };
  const pal = paletteFor(panel);
  if (!pal.some(([, c]) => c.join() === paint.color.join())) paint.color = pal[0][1];

  const toolBtn = (id, label, title) => h('button', {
    class: paint.tool === id ? 'on' : '', title,
    onclick: () => setTool(id),
  }, label);
  const swatches = pal.map(([name, c], i) => h('button', {
    class: `swatch${paint.color.join() === c.join() && paint.tool !== 'eraser' ? ' on' : ''}`, title: `${name} (${i + 1})`,
    style: `background:${rgbToHex(c)}`,
    onclick: () => { paint.color = c; if (paint.tool === 'eraser') paint.tool = 'pencil'; renderInspector(); },
  }));

  const pixels = currentCanvasPixels(n);
  const cw = pixels?.width ?? 0;
  const ch = pixels?.height ?? 0;
  const sizeW = numInput(() => cw, () => {}, { min: 1, max: 2048 });
  const sizeH = numInput(() => ch, () => {}, { min: 1, max: 512 });

  const resizeTo = (w, hh) => {
    const src = currentCanvasPixels(n);
    if (!src) return;
    const dst = newCanvasEl(w, hh);
    dst.getContext('2d').drawImage(src, 0, 0);
    selection = null;
    storeCanvas(n, dst);
    afterEdit(`canvas-resize:${performance.now()}`, true);
  };

  const sel = hasSelection(n);
  const selBtn = (label, title, fn, disabled = false) => h('button', { title, disabled, onclick: fn }, label);

  box.append(
    h('h4', {}, 'Paint'),
    h('p', { class: 'note' }, 'Left-click paints, right-click erases. One canvas pixel is one LED. Select the window in the tree to move or resize it.'),
    h('div', { class: 'rt-toolbar' },
      toolBtn('pencil', 'Pencil (P)', 'Draw (P)'), toolBtn('eraser', 'Eraser (E)', 'Turn LEDs off (E)'),
      toolBtn('fill', 'Fill (F)', 'Flood fill (F)'), toolBtn('select', 'Select (S)', 'Select a block of pixels (S)')),
    h('div', { class: 'rt-toolbar' }, swatches),
  );
  if (paint.tool === 'select') {
    box.append(
      h('h4', {}, sel ? `Selection ${selection.w}×${selection.h} at ${selection.x},${selection.y}` : 'Selection'),
      h('p', { class: 'note' }, 'Drag to select. Drag inside the selection to move it; hold Alt/Ctrl/⌘ while dragging to copy it.'),
      h('div', { class: 'rt-toolbar' },
        selBtn('Copy', 'Ctrl/⌘+C', () => selCopy(n), !sel),
        selBtn('Cut', 'Ctrl/⌘+X', () => selCut(n), !sel),
        selBtn('Paste', 'Ctrl/⌘+V', () => selPaste(n), !pixelClipboard),
        selBtn('Fill', 'Fill with the current colour (G)', () => selFill(n), !sel),
        selBtn('Clear', 'Turn the selection off (Delete)', () => selClear(n), !sel)),
      h('div', { class: 'rt-toolbar' },
        selBtn('Select all', 'Ctrl/⌘+A', () => selAll(n)),
        selBtn('Deselect', 'Esc', () => deselect(), !sel)),
    );
  }
  box.append(
    h('h4', {}, 'Canvas'),
    row('Size (px)', sizeW, h('span', {}, '×'), sizeH),
    row('', h('button', { onclick: () => { if (sizeW.value > 0 && sizeH.value > 0) resizeTo(+sizeW.value, +sizeH.value); } }, 'Apply size'),
      h('button', { disabled: !winRect.w, onclick: () => resizeTo(winRect.w, winRect.h) }, 'Fit to window')),
    row('', h('button', {
      onclick: () => { selection = null; const c = newCanvasEl(cw || 1, ch || 1); storeCanvas(n, c); afterEdit(`canvas-clear:${performance.now()}`); renderInspector(); },
    }, 'Clear all'), h('button', {
      onclick: async () => {
        const r = await window.api.pickImage();
        if (!r) return;
        const img = new Image();
        img.onload = () => {
          const c = newCanvasEl(cw || img.width, ch || img.height);
          const cx = c.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0, c.width, c.height);
          const data = cx.getImageData(0, 0, c.width, c.height);
          quantizeToPlanes(data.data, panelColorType(panel)); // only colours the sign can show
          cx.putImageData(data, 0, 0);
          selection = null;
          storeCanvas(n, c);
          afterEdit(`canvas-import:${performance.now()}`);
        };
        img.src = r.dataUrl;
      },
    }, 'Import image…')),
    h('h4', {}, 'Hotkeys'),
    h('p', { class: 'note' }, 'P pencil · E eraser · F fill · S select · 1–7 colour · G fill selection · Delete clear selection · Esc deselect · Ctrl/⌘ + A / C / X / V'),
  );
}

async function cmdAddCanvas() {
  const { win } = context();
  if (!win) return status('Select a window first.');
  const r = windowRect(win);
  const page = newCanvas(win.children, pngBase64(newCanvasEl(r.w, r.h)));
  insertAfter(win, context().page, page);
  state.sel = page;
  afterEdit(null);
  renderInspector();
  status('Added canvas page: paint on the preview');
}

// ---------------------------------------------------------------------------------------------
// Stage

let pitch = 8;
let player = null;
let rafId = 0;
let lastTs = 0;

function stagePanelAndProgram() {
  const ctx = context();
  const panel = ctx.panel;
  const program = ctx.program ?? panel?.children.find((c) => c.long === T.PROGRAM) ?? null;
  return { panel, program, ctx };
}

function renderStage() {
  const { panel, program, ctx } = stagePanelAndProgram();
  if (!panel) return;
  const size = panelSize(panel);
  stageTitle.textContent = `${panel.great} — ${size.width}×${size.height}${program ? ` — ${program.great}` : ''}`;
  statusInfo.textContent = state.filePath ?? 'unsaved project';
  if (state.previewing) return; // the player owns the canvas
  try {
    const frame = renderStaticProgram(panel, program, {
      pickPage: (win) => {
        const chain = ctx.chain;
        return win.children.find((p) => chain.includes(p)) ?? null;
      },
      getImage,
    });
    drawLedPanel(ledEl, frame, pitch);
  } catch (err) {
    console.error(err);
    status(`Preview error: ${err.message}`, 8000);
  }
  renderOverlay(panel, program, ctx);
  stageHint.textContent = ctx.page && pageKind(ctx.page) === 'canvas'
    ? 'Painting: left-click paints, right-click erases. P / E / F / S switch tools.'
    : ctx.win || ctx.page
    ? 'Drag the highlighted window to move it; drag its handles to resize.'
    : 'Select a window in the tree (or click a zone) to position it.';
}

function renderOverlay(panel, program, ctx) {
  overlayEl.replaceChildren();
  if (!program) return;
  const selWin = ctx.win;
  for (const win of program.children) {
    if (win.long !== T.WINDOW) continue;
    const r = windowRect(win);
    const zone = h('div', {
      class: `zone${win === selWin ? ' sel' : ''}`,
      style: `left:${r.x * pitch}px;top:${r.y * pitch}px;width:${r.w * pitch}px;height:${r.h * pitch}px`,
      onpointerdown: (e) => startDrag(e, win, 'move'),
    }, h('span', { class: 'tag' }, `${r.w}×${r.h}`));
    if (win === selWin) {
      for (const hd of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        zone.append(h('div', { class: 'handle', 'data-h': hd, onpointerdown: (e) => { e.stopPropagation(); startDrag(e, win, hd); } }));
      }
    }
    overlayEl.append(zone);
  }
  if (ctx.page && ctx.win && pageKind(ctx.page) === 'canvas') {
    const r = windowRect(ctx.win);
    const surface = h('div', {
      class: 'paint',
      style: `left:${r.x * pitch}px;top:${r.y * pitch}px;width:${r.w * pitch}px;height:${r.h * pitch}px;background-size:${pitch}px ${pitch}px`,
    });
    surface.addEventListener('pointerdown', (e) => {
      const b = surface.getBoundingClientRect();
      startCanvasPointer(e, ctx.page, { left: b.left, top: b.top, w: r.w, h: r.h });
    });
    surface.addEventListener('contextmenu', (e) => e.preventDefault()); // right button erases
    if (hasSelection(ctx.page)) {
      const px = currentCanvasPixels(ctx.page);
      const ox = px ? Math.round((r.w - px.width) / 2) : 0;
      const oy = px ? Math.round((r.h - px.height) / 2) : 0;
      surface.append(h('div', {
        class: 'selbox',
        style: `left:${(ox + selection.x) * pitch}px;top:${(oy + selection.y) * pitch}px;width:${selection.w * pitch}px;height:${selection.h * pitch}px`,
      }));
    }
    overlayEl.append(surface);
  }
}

function startDrag(e, win, mode) {
  e.preventDefault();
  if (state.sel !== win && !(context().win === win)) select(win);
  const { panel } = stagePanelAndProgram();
  const size = panelSize(panel);
  const start = windowRect(win);
  const x0 = e.clientX;
  const y0 = e.clientY;
  let scheduled = false;
  const move = (ev) => {
    const dx = Math.round((ev.clientX - x0) / pitch);
    const dy = Math.round((ev.clientY - y0) / pitch);
    let { x, y, w, h: hh } = start;
    if (mode === 'move') {
      x = Math.max(0, Math.min(size.width - w, start.x + dx));
      y = Math.max(0, Math.min(size.height - hh, start.y + dy));
    } else {
      let left = start.x;
      let top = start.y;
      let right = start.x + start.w;
      let bottom = start.y + start.h;
      if (mode.includes('w')) left = Math.max(0, Math.min(right - 1, left + dx));
      if (mode.includes('e')) right = Math.min(size.width, Math.max(left + 1, right + dx));
      if (mode.includes('n')) top = Math.max(0, Math.min(bottom - 1, top + dy));
      if (mode.includes('s')) bottom = Math.min(size.height, Math.max(top + 1, bottom + dy));
      x = left; y = top; w = right - left; hh = bottom - top;
    }
    win.set('rect', formatRect({ x, y, w, h: hh }));
    syncRectInputs({ x, y, w, h: hh });
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; renderStage(); renderTree(); });
    }
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    commit(`rect:${performance.now()}`); // one undo step per drag
    afterEditSoft();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function fitZoom() {
  const { panel } = stagePanelAndProgram();
  if (!panel) return;
  const { width } = panelSize(panel);
  const avail = $('#stageScroll').clientWidth - 70;
  pitch = Math.max(2, Math.min(24, Math.floor(avail / width)));
  zoomEl.value = pitch;
}

// ---------------------------------------------------------------------------------------------
// Preview

function startPreview() {
  const { panel, program } = stagePanelAndProgram();
  if (!panel) return;
  const only = $('#onlySel')?.checked;
  const programs = only && program ? [program] : undefined;
  player = new Player(panel, { getImage, programs });
  if (!player.programs.length) {
    status('Nothing to preview: no enabled programs.', 5000);
    stopPreview();
    return;
  }
  state.previewing = true;
  document.body.classList.add('previewing');
  const btn = $('#btnPreview');
  btn.textContent = '■ Stop';
  btn.classList.add('on');
  cancelAnimationFrame(rafId);
  lastTs = performance.now();
  const loop = (ts) => {
    if (!state.previewing) return;
    const dt = Math.min(100, ts - lastTs);
    lastTs = ts;
    player.tick(dt);
    drawLedPanel(ledEl, player.render(), pitch);
    stageHint.textContent = `Playing: ${player.programName}`;
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

function stopPreview() {
  state.previewing = false;
  document.body.classList.remove('previewing');
  cancelAnimationFrame(rafId);
  const btn = $('#btnPreview');
  btn.textContent = '▶ Preview';
  btn.classList.remove('on');
  player = null;
  renderStage();
}

function togglePreview() {
  if (state.previewing) stopPreview(); else startPreview();
}

// ---------------------------------------------------------------------------------------------
// Refresh plumbing

function refreshAll() {
  renderTree();
  renderInspector();
  fitZoom();
  renderStage();
  if (state.previewing) startPreview();
}

// Called after a property edit. `rebuildInspector` is only needed when fields depend on each other.
function afterEdit(key, rebuildInspector = false) {
  commit(key);
  afterEditSoft();
  if (rebuildInspector) renderInspector();
}

function afterEditSoft() {
  renderTree();
  renderStage();
  if (state.previewing) startPreview();
}

// ---------------------------------------------------------------------------------------------
// Commands

async function confirmDiscard() {
  if (!isDirty()) return true;
  const r = await dialog({
    title: 'Unsaved changes',
    body: 'This project has changes that have not been saved.',
    buttons: [{ label: 'Save', value: 'save', primary: true }, { label: 'Discard', value: 'discard' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (r === 'save') return save(false);
  return r === 'discard';
}

function loadProject(proj, filePath) {
  stopPreview();
  state.project = proj;
  state.filePath = filePath;
  state.sel = panels(proj)[0] ?? proj.root;
  state.collapsed.clear();
  images.clear();
  resetHistory();
  refreshAll();
}

async function newDoc() {
  if (!(await confirmDiscard())) return;
  loadProject(newProject(), null);
  status('New project');
}

async function openDoc(known) {
  if (!(await confirmDiscard())) return;
  const r = known ?? (await window.api.openProject());
  if (!r) return;
  try {
    const proj = parseProject(r.text);
    loadProject(proj, r.path);
    const note = proj.sourceFormat === 'v3' ? ' (imported from the newer led595 format; saving writes the classic format)' : '';
    status(`Opened ${r.path.split(/[\\/]/).pop()}${note}`, 7000);
  } catch (err) {
    await dialog({ title: 'Could not open project', body: `<pre>${esc(err.message)}</pre>` });
  }
}

async function save(saveAs) {
  const text = serializeProject(state.project);
  const r = await window.api.saveProject({ path: state.filePath, text, saveAs });
  if (!r) return false;
  state.filePath = r.path;
  history.savedText = text;
  history.text = text;
  reportDocState();
  window.api.notifySaved();
  renderStage();
  status(`Saved ${r.path.split(/[\\/]/).pop()}`);
  return true;
}

function insertAfter(parent, ref, node) {
  const i = ref ? parent.children.indexOf(ref) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i + 1, 0, node);
}

function cmdAddProgram() {
  const { panel, program } = context();
  if (!panel) return;
  const p = newProgram(panel, panel.children);
  insertAfter(panel, program, p);
  state.sel = p;
  afterEdit(null);
  renderInspector();
  status(`Added ${p.great}`);
}

function cmdAddWindow() {
  const { panel, program } = context();
  const prog = program ?? panel?.children.find((c) => c.long === T.PROGRAM);
  if (!prog) return status('Add a program first.');
  const { width, height } = panelSize(panel);
  const rect = prog.children.length === 0
    ? [0, 0, width, height]
    : [Math.floor(width / 4), Math.floor(height / 4), Math.floor(width / 4) + Math.max(1, Math.floor(width / 2)), Math.floor(height / 4) + Math.max(1, Math.floor(height / 2))];
  const w = newWindow(rect);
  insertAfter(prog, context().win, w);
  state.sel = w;
  afterEdit(null);
  renderInspector();
  status('Added window');
}

function cmdAddPage(kind, path = '') {
  const { win } = context();
  if (!win) return status('Select a window first.');
  const page = kind === 'media' ? newMedia(win.children, path) : newText(win.children);
  insertAfter(win, context().page, page);
  state.sel = page;
  afterEdit(null);
  renderInspector();
  status(`Added ${kind} page`);
}

async function cmdAddMedia() {
  if (!context().win) return status('Select a window first.');
  const r = await window.api.pickImage();
  if (!r) return;
  const img = new Image();
  img.onload = () => {
    images.set(`${state.filePath ?? ''}|${r.resolved}`, { img, resolved: r.resolved });
    cmdAddPage('media', r.resolved);
    // fit the window to the image when it is the only content
    const { win } = context();
    if (win && win.children.length === 1) {
      const { x, y } = windowRect(win);
      win.set('rect', formatRect({ x, y, w: img.naturalWidth, h: img.naturalHeight }));
      afterEditSoft();
    }
  };
  img.src = r.dataUrl;
}

function cmdDelete() {
  const n = state.sel;
  const chain = ancestors(n);
  if (!chain || chain.length < 2) return;
  const parent = chain[chain.length - 2];
  const i = parent.children.indexOf(n);
  parent.children.splice(i, 1);
  state.sel = parent.children[Math.min(i, parent.children.length - 1)] ?? (parent.long === T.ROOT ? null : parent);
  if (!state.sel) {
    state.project.root.children.push(newProject().root.children[0]);
    state.sel = state.project.root.children[0];
  }
  afterEdit(null);
  renderInspector();
  status('Deleted');
}

function cmdDuplicate() {
  const n = state.sel;
  const chain = ancestors(n);
  if (!chain || chain.length < 2) return;
  const parent = chain[chain.length - 2];
  const copy = n.clone();
  copy.great = `${n.great} copy`;
  parent.children.splice(parent.children.indexOf(n) + 1, 0, copy);
  state.sel = copy;
  afterEdit(null);
  renderInspector();
}

function cmdMove(dir) {
  const n = state.sel;
  const chain = ancestors(n);
  if (!chain || chain.length < 2) return;
  const parent = chain[chain.length - 2];
  const i = parent.children.indexOf(n);
  const j = i + dir;
  if (j < 0 || j >= parent.children.length) return;
  [parent.children[i], parent.children[j]] = [parent.children[j], parent.children[i]];
  afterEdit(null);
}

async function cmdExportUsb() {
  stopPreview();
  const { panel } = context();
  if (!panel) return;
  const plan = collectPrograms(panel);
  if (!plan.programs.length) {
    await dialog({ title: 'Export to USB', body: `<p>Nothing to export: tick at least one program that has a text or image page.</p>${plan.notes.length ? `<pre>${esc(plan.notes.join('\n'))}</pre>` : ''}` });
    return;
  }

  // Every image must be on disk and decoded before we rasterise; a missing one would be exported as a blank placeholder.
  const wanted = [...new Set(plan.programs.flatMap((p) => p.windows).flatMap((w) => w.pages)
    .filter((pg) => ['media', 'canvas'].includes(pageKind(pg)))
    .map((pg) => (pageKind(pg) === 'canvas' ? `data:image/png;base64,${pg.get('cvpng')}` : pg.get('ip04'))))];
  for (let tries = 0; tries < 30 && wanted.some((p) => !getImage(p)); tries++) await new Promise((r) => setTimeout(r, 100));
  const missing = wanted.filter((p) => !getImage(p));
  if (missing.length) {
    await dialog({
      title: 'Images not found',
      body: `<p>These images could not be found on this computer, so the export would contain blank pictures. Relink them with <b>Browse…</b> on each media page first.</p><pre>${esc(missing.map((m) => m.slice(0, 80)).join('\n'))}</pre>`,
    });
    return;
  }

  const dir = await window.api.chooseExportFolder();
  if (!dir) return;
  const src = await window.api.readExportSource(dir);

  const useTfr = h('input', { type: 'checkbox', checked: !!src?.tfr });
  const stale = (src?.existing ?? []);
  const sizeInfo = panelSize(panel);
  const nameOfNew = `${sizeInfo.width}${sizeInfo.height}${panel.int('pc', 2)}.TFU`;
  const staleOthers = stale.filter((n) => n.toUpperCase() !== nameOfNew.toUpperCase() && n.toUpperCase() !== 'LED.TFU');
  const removeStale = h('input', { type: 'checkbox', checked: staleOthers.length > 0 });
  const body = h('div', {},
    h('p', {}, `Export "${panel.great}" (${sizeInfo.width}×${sizeInfo.height}, ${COLOR_TYPES[panelColorType(panel) - 1].split(' ')[0]}) to:`),
    h('pre', {}, dir),
    h('p', { class: 'note' }, `${plan.programs.length} program(s) will be written to POWERLED/${nameOfNew} and POWERLED/LED.TFU.`),
    src?.tfr ? h('label', { class: 'inline' }, useTfr, ' Use the panel parameters from this disk\'s LED.TFR (what the controller reported)') : null,
    staleOthers.length ? h('div', {}, h('label', { class: 'inline' }, removeStale, ` Delete other programs in POWERLED: ${staleOthers.join(', ')}`)) : null,
    plan.notes.length ? h('pre', { class: 'warn' }, plan.notes.join('\n')) : null,
    h('p', { class: 'note' }, 'Existing LED.TFU / ' + nameOfNew + ' on the disk will be replaced.'),
  );
  const go = await dialog({
    title: 'Export to USB disk',
    body,
    buttons: [{ label: 'Export', value: 'go', primary: true }, { label: 'Cancel', value: 'cancel' }],
  });
  if (go !== 'go') return;

  let built;
  try {
    built = buildUsbExport(state.project, panel, {
      rasterize: (page, rect) => rasterizePageForExport(page, rect, getImage),
      configOverride: useTfr.checked && src?.tfr ? configFromTfr(Uint8Array.from(src.tfr)) : null,
    });
  } catch (err) {
    await dialog({ title: 'Export failed', body: `<pre>${esc(err.message)}</pre>` });
    return;
  }
  const remove = removeStale.checked ? staleOthers : [];
  const res = await window.api.writeExport(dir, built.files, remove);
  const done = await dialog({
    title: 'Export complete',
    body: `<p>${esc(built.summary)}. Eject the disk before unplugging it, then insert it into the controller.</p><pre>${esc(res.written.join('\n'))}</pre>${res.removed.length ? `<p>Removed:</p><pre>${esc(res.removed.join('\n'))}</pre>` : ''}`,
    buttons: [{ label: 'Eject USB Disk', value: 'eject', primary: true }, { label: 'Done', value: 'done' }],
  });
  if (done === 'eject') {
    const r = await window.api.ejectDisk(dir);
    await dialog({
      title: r.ok ? 'Disk ejected' : 'Could not eject',
      body: r.ok ? '<p>It is now safe to unplug the USB disk.</p>' : `<p>${esc(r.message)}</p><p>Eject it from your file manager before unplugging.</p>`,
    });
  }
  status('Exported to USB');
}

const COMMANDS = {
  new: newDoc,
  open: () => openDoc(),
  save: () => save(false),
  'save-as': () => save(true),
  undo,
  redo,
  delete: cmdDelete,
  duplicate: cmdDuplicate,
  'move-up': () => cmdMove(-1),
  'move-down': () => cmdMove(1),
  'add-program': cmdAddProgram,
  'add-window': cmdAddWindow,
  'add-text': () => cmdAddPage('text'),
  'add-media': cmdAddMedia,
  'add-canvas': cmdAddCanvas,
  'toggle-preview': togglePreview,
  'export-usb': cmdExportUsb,
  'zoom-in': () => setZoom(pitch + 1),
  'zoom-out': () => setZoom(pitch - 1),
  'zoom-fit': () => { fitZoom(); renderStage(); },
};

function run(name) {
  if (name.startsWith('open-path:')) {
    window.api.openPath(name.slice('open-path:'.length)).then((r) => openDoc(r));
    return;
  }
  const fn = COMMANDS[name];
  if (fn) Promise.resolve(fn()).catch((err) => { console.error(err); status(`Error: ${err.message}`, 8000); });
}


// ---------------------------------------------------------------------------------------------
// Context menu (right-click in the tree)

let menuEl = null;

function closeContextMenu() {
  menuEl?.remove();
  menuEl = null;
}

function showContextMenu(x, y, items) {
  closeContextMenu();
  menuEl = h('div', { class: 'ctxmenu', role: 'menu' }, items.map((it) => (it.separator
    ? h('div', { class: 'sep' })
    : h('button', {
      class: it.danger ? 'danger' : '', disabled: !!it.disabled, role: 'menuitem',
      onclick: () => { closeContextMenu(); it.action(); },
    }, it.label))));
  document.body.append(menuEl);
  const b = menuEl.getBoundingClientRect();
  menuEl.style.left = `${Math.max(4, Math.min(x, innerWidth - b.width - 4))}px`;
  menuEl.style.top = `${Math.max(4, Math.min(y, innerHeight - b.height - 4))}px`;
}

function menuItemsFor(n) {
  const siblings = (ancestors(n) ?? []).slice(-2, -1)[0]?.children ?? [];
  const i = siblings.indexOf(n);
  const kind = pageKind(n);
  const common = [
    { label: 'Duplicate', action: cmdDuplicate },
    { label: 'Move Up', action: () => cmdMove(-1), disabled: i <= 0 },
    { label: 'Move Down', action: () => cmdMove(1), disabled: i < 0 || i >= siblings.length - 1 },
  ];
  const toggle = (label) => ({ label, action: () => { n.enabled = !n.enabled; afterEdit('enable'); } });
  switch (n.long) {
    case T.PANEL:
      return [{ label: 'Add Program', action: cmdAddProgram }, { separator: true }, toggle(n.enabled ? 'Untick (exclude)' : 'Tick (include)'),
        { separator: true }, { label: 'Delete Panel', action: cmdDelete, danger: true }];
    case T.PROGRAM:
      return [{ label: 'Add Window', action: cmdAddWindow }, { separator: true }, ...common, { separator: true },
        toggle(n.enabled ? 'Untick (exclude)' : 'Tick (include)'), { separator: true }, { label: 'Delete Program', action: cmdDelete, danger: true }];
    case T.WINDOW:
      return [{ label: 'Add Text Page', action: () => cmdAddPage('text') }, { label: 'Add Media Page…', action: cmdAddMedia },
        { label: 'Add Canvas Page', action: cmdAddCanvas }, { separator: true }, ...common, { separator: true },
        { label: 'Delete Window', action: cmdDelete, danger: true }];
    default: {
      const word = kind === 'media' ? 'Media' : kind === 'canvas' ? 'Canvas' : kind === 'text' ? 'Text' : 'Page';
      return [...common, { separator: true }, toggle(n.enabled ? 'Hide Page' : 'Show Page'), { separator: true },
        { label: `Delete ${word}`, action: cmdDelete, danger: true }];
    }
  }
}

treeEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.node');
  if (!row?.__node) return;
  e.preventDefault();
  const x = e.clientX, y = e.clientY;
  select(row.__node);
  showContextMenu(x, y, menuItemsFor(row.__node));
});
window.addEventListener('pointerdown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeContextMenu(); }, true);
window.addEventListener('blur', closeContextMenu);
window.addEventListener('resize', closeContextMenu);
treeEl.addEventListener('scroll', closeContextMenu);

// ---------------------------------------------------------------------------------------------
// Init

document.querySelectorAll('#toolbar [data-cmd]').forEach((b) => b.addEventListener('click', () => run(b.dataset.cmd)));
window.api.onMenu(run);
zoomEl.addEventListener('input', () => setZoom(+zoomEl.value));

// Zoom the LED preview/canvas. With `anchor` ({clientX, clientY}) the LED under the pointer stays put.
const MIN_ZOOM = 1;
const MAX_ZOOM = 40;
function setZoom(next, anchor = null) {
  next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next)));
  if (next === pitch) return;
  const before = ledEl.getBoundingClientRect();
  const fx = anchor ? (anchor.clientX - before.left) / pitch : null;
  const fy = anchor ? (anchor.clientY - before.top) / pitch : null;
  pitch = next;
  zoomEl.value = pitch;
  renderStage();
  if (state.previewing && player) drawLedPanel(ledEl, player.frame, pitch);
  if (anchor) {
    const scroller = $('#stageScroll');
    const after = ledEl.getBoundingClientRect();
    scroller.scrollLeft += after.left + fx * pitch - anchor.clientX;
    scroller.scrollTop += after.top + fy * pitch - anchor.clientY;
  }
  status(`Zoom ${pitch}×`, 1200);
}

let wheelAcc = 0;
$('#stageScroll').addEventListener('wheel', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return; // plain scrolling still scrolls
  e.preventDefault();
  wheelAcc += e.deltaY;
  const steps = Math.trunc(wheelAcc / 30);
  if (!steps) return;
  wheelAcc -= steps * 30;
  setZoom(pitch - steps, e); // scrolling up (negative delta) zooms in
}, { passive: false });
window.addEventListener('resize', () => { /* keep user zoom */ });
const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && menuEl) { closeContextMenu(); return; }
  if ((e.metaKey || e.ctrlKey) && !e.altKey) { // also reachable via the View menu accelerators
    if (e.key === '+' || e.key === '=') { e.preventDefault(); run('zoom-in'); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); run('zoom-out'); return; }
    if (e.key === '0') { e.preventDefault(); run('zoom-fit'); return; }
  }
  if (isTyping()) return;
  const page = activeCanvasPage();
  if (page && !state.previewing) {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    let handled = true;
    if (!mod && !e.altKey && TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
    else if (!mod && /^[1-7]$/.test(k)) {
      const pal = paletteFor(context().panel);
      const c = pal[+k - 1];
      if (c) { paint.color = c[1]; if (paint.tool === 'eraser') paint.tool = 'pencil'; renderInspector(); }
    } else if (!mod && k === 'g') selFill(page);
    else if (e.key === 'Delete' || e.key === 'Backspace') selClear(page); // never deletes the page itself
    else if (e.key === 'Escape') deselect();
    else if (mod && k === 'a') { setTool('select'); selAll(page); }
    else if (mod && k === 'c') selCopy(page);
    else if (mod && k === 'x') selCut(page);
    else if (mod && k === 'v') selPaste(page);
    else handled = false;
    if (handled) e.preventDefault();
    return;
  }
  if (e.key === 'Delete') run('delete');
});

// Menu accelerators (Cmd/Ctrl+C/X/V) reach the page as clipboard events rather than key presses.
for (const [type, fn] of [['copy', selCopy], ['cut', selCut], ['paste', selPaste]]) {
  document.addEventListener(type, (e) => {
    const page = activeCanvasPage();
    if (!page || isTyping() || state.previewing) return;
    e.preventDefault();
    fn(page);
  });
}

const onlySel = h('label', { class: 'inline', title: 'Loop only the selected program in the preview' },
  h('input', { type: 'checkbox', id: 'onlySel', onchange: () => state.previewing && startPreview() }), 'Selected program only');
$('#stageBar').insertBefore(onlySel, zoomEl.closest('label'));

resetHistory();
refreshAll();
status('Ready', 0);

// Debug/test hook (used by test/shot.cjs).
window.__powerled = { state, history, run, serialize: () => serializeProject(state.project) };
