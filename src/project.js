// PowerLED project model (.ledprj, "project ver=2" schema as written by PowerLed.exe).
//
// The file is a tree of <LongGreat> nodes:
//   root(0) -> panel(120) -> program(110) -> window(100) -> page(1 text, 2 media, 11 date/time, ...)
// Each node has <long>=type, <great>=name, <fore>=enabled (ticked), <slt>=selected-in-UI,
// then flat property elements, then child <LongGreat> nodes.
import { parseXml, escapeText } from './xml.js';
import { TEMPLATES } from './templates.js';

export const T = {
  ROOT: 0,
  WINDOW: 100,
  PROGRAM: 110,
  PANEL: 120,
  TEXT: 1,
  MEDIA: 2,
  DATETIME: 11,
};

// Page types we cannot edit yet are preserved verbatim and shown as a labelled placeholder.
export const PAGE_TYPE_NAMES = {
  1: 'Text', 2: 'Media', 3: 'Clock', 8: 'Table', 9: 'Animate', 10: 'Countdown', 11: 'Date/Time', 12: 'Temperature',
};

// Entry-effect names, index == value of <action>. Taken from the stock English string table (id 3225).
export const ACTIONS = [
  'Random', 'Direct', 'Always hold', 'Continuous move left', 'Move left', 'Continuous move right', 'Move right',
  'Move up', 'Move down', 'Wear', 'Rain', 'Fountain', 'Flash', 'Reverse flash', 'Scroll open', 'Scroll close',
  'Left laser', 'Right laser', 'Top laser', 'Bottom laser', 'Stretching to left', 'Stretching to right',
  'Stretching to top', 'Stretching to bottom', 'From lower left', 'From upper left', 'From lower right',
  'From upper right', 'Cover from left', 'Cover from right', 'Cover from top', 'Cover from bottom',
  'Horizontal open', 'Horizontal close', 'Vertical open', 'Vertical close', 'Horizontal shutter',
  'Vertical shutter', 'Vertical cross move', 'Horizontal cross move', 'Vertical cross open',
  'Horizontal cross open', 'Mosaics', 'Diamond open', 'Diamond close', 'Fall', 'Tipsy show',
];

// <pc> is the number of colour planes the panel has: 1 = R, 2 = RG (bicolor), 3 = RGB.
export const COLOR_TYPES = ['R (single color)', 'RG (red + green)', 'RGB (full color)'];
export const WEEK_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const PICTURE_POSITIONS = ['Stretch', 'Center', 'Tile'];
export const VERTICAL_ALIGN = ['Top', 'Middle', 'Bottom'];

export class Node {
  constructor(long = 0, great = '') {
    this.long = long;
    this.great = great;
    this.fore = 1;
    this.slt = 0;
    this.props = []; // ordered [key, value] pairs, values are strings
    this.children = [];
  }

  has(k) {
    return this.props.some((p) => p[0] === k);
  }

  get(k, d = '') {
    const p = this.props.find((q) => q[0] === k);
    return p ? p[1] : d;
  }

  int(k, d = 0) {
    const v = parseInt(this.get(k, ''), 10);
    return Number.isNaN(v) ? d : v;
  }

  set(k, v) {
    v = String(v);
    const p = this.props.find((q) => q[0] === k);
    if (p) p[1] = v;
    else this.props.push([k, v]);
  }

  clone() {
    const n = new Node(this.long, this.great);
    n.fore = this.fore;
    n.slt = this.slt;
    n.props = this.props.map((p) => [p[0], p[1]]);
    n.children = this.children.map((c) => c.clone());
    return n;
  }

  get enabled() {
    return this.fore !== 0;
  }

  set enabled(v) {
    this.fore = v ? 1 : 0;
  }
}

function fromElement(el) {
  const n = new Node();
  for (const c of el.children) {
    if (c.name === 'LongGreat') {
      n.children.push(fromElement(c));
    } else if (c.name === 'long') n.long = parseInt(c.text, 10) || 0;
    else if (c.name === 'great') n.great = c.text;
    else if (c.name === 'fore') n.fore = parseInt(c.text, 10) || 0;
    else if (c.name === 'slt') n.slt = parseInt(c.text, 10) || 0;
    else n.props.push([c.name, c.text]);
  }
  return n;
}

export function parseProject(text) {
  const doc = parseXml(text);
  if (doc.name === 'led595') return convertV3(doc);
  if (doc.name !== 'project') throw new Error(`Not a PowerLED project (root <${doc.name}>)`);
  const rootEl = doc.children.find((c) => c.name === 'LongGreat');
  if (!rootEl) throw new Error('Project has no root node');
  const start = text.indexOf('<project');
  const end = text.lastIndexOf('</project>') + '</project>'.length;
  return {
    version: doc.attrs.ver ?? '2',
    root: fromElement(rootEl),
    sourceFormat: 'v2',
    prolog: text.slice(text.charCodeAt(0) === 0xfeff ? 1 : 0, start),
    epilog: text.slice(end),
  };
}

const prop = (k, v) => (v === '' ? `<${k}/>` : `<${k}>${escapeText(v)}</${k}>`);

function writeNode(n) {
  let s = `<LongGreat><long>${n.long}</long><great>${escapeText(n.great)}</great><fore>${n.fore}</fore><slt>${n.slt}</slt>`;
  for (const [k, v] of n.props) s += prop(k, v);
  for (const c of n.children) s += writeNode(c);
  return s + '</LongGreat>';
}

export function serializeProject(proj) {
  const prolog = proj.prolog ?? '<?xml version = "1.0"?>\n';
  const epilog = proj.epilog ?? '\n';
  return `${prolog}<project ver="${proj.version ?? '2'}">${writeNode(proj.root)}</project>${epilog}`;
}

// ---------------------------------------------------------------------------------------------
// Construction

function fromTemplate(long, great, props) {
  const n = new Node(long, great);
  n.props = props.map((p) => [p[0], p[1]]);
  return n;
}

function uniqueName(base, siblings) {
  const used = new Set(siblings.map((s) => s.great));
  for (let i = siblings.length + 1; ; i++) if (!used.has(base + i)) return base + i;
}

export function newText(siblings = []) {
  const n = fromTemplate(T.TEXT, uniqueName('Text', siblings), TEMPLATES.text);
  n.set('action', 1);
  n.set('speed', 1);
  n.set('delay', 100);
  n.set('rtf', buildPlainRtf('Hello', [255, 0, 0], 20));
  n.set('sm', 'Hello');
  return n;
}

export function newMedia(siblings = [], path = '') {
  const n = fromTemplate(T.MEDIA, uniqueName('Media', siblings), TEMPLATES.media);
  n.set('ip04', path);
  return n;
}

export function newCanvas(siblings = [], pngBase64 = '') {
  const n = fromTemplate(T.MEDIA, uniqueName('Canvas', siblings), TEMPLATES.media);
  n.set('ip04', ''); // no file: other PowerLED builds just see an image page with an empty path
  n.set('ip01', 1); // centred, never rescaled, so one canvas pixel == one LED
  n.set('cvpng', pngBase64);
  return n;
}

export function canvasDataUrl(page) {
  return `data:image/png;base64,${page.get('cvpng')}`;
}

export function newWindow(rect, siblings = []) {
  const n = fromTemplate(T.WINDOW, 'Window1', TEMPLATES.window);
  n.fore = 0; // matches PowerLed.exe: windows are saved with fore=0
  n.set('rect', rect.join(','));
  n.children.push(newText([]));
  return n;
}

export function newProgram(panel, siblings = []) {
  const n = fromTemplate(T.PROGRAM, uniqueName('Program', siblings), TEMPLATES.program);
  const { width, height } = panelSize(panel);
  n.children.push(newWindow([0, 0, width, height]));
  return n;
}

export function newPanel(name = 'Panel1') {
  const n = fromTemplate(T.PANEL, name, TEMPLATES.panel);
  n.slt = 1;
  n.children.push(newProgram(n, []));
  return n;
}

export function newProject() {
  const root = new Node(T.ROOT, 'NULL');
  root.fore = 0; // PowerLed writes the root node unticked
  root.slt = 1;
  root.children.push(newPanel());
  const panel = root.children[0];
  panel.children[0].slt = 1;
  panel.children[0].children[0].slt = 1;
  return { version: '2', root, sourceFormat: 'v2' };
}

function buildPlainRtf(text, rgb, halfPoints) {
  const [r, g, b] = rgb;
  return (
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}\n' +
    `{\\colortbl ;\\red${r}\\green${g}\\blue${b};}\n` +
    `\\viewkind4\\uc1\\pard\\cf1\\fs${halfPoints} ${text}\\par\n}\n`
  );
}

// ---------------------------------------------------------------------------------------------
// Accessors for the cryptic v2 tags

export function panels(proj) {
  return proj.root.children.filter((c) => c.long === T.PANEL);
}

export function panelSize(panel) {
  return { width: panel.int('pw', 128), height: panel.int('ph1', 16) };
}

export function setPanelSize(panel, width, height) {
  panel.set('pw', width);
  panel.set('ph1', height);
  panel.set('pwb', Math.ceil(width / 4)); // bytes-per-row field PowerLed keeps beside the width
}

// number of colour planes: 1 = R, 2 = RG, 3 = RGB
export function panelColorType(panel) {
  return Math.max(1, Math.min(3, panel.int('pc', 2)));
}

export function parseRect(s) {
  const [l = 0, t = 0, r = 0, b = 0] = String(s).split(',').map((x) => parseInt(x, 10) || 0);
  return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) };
}

export function formatRect({ x, y, w, h }) {
  return [x, y, x + w, y + h].join(',');
}

export function windowRect(win) {
  return parseRect(win.get('rect', '0,0,0,0'));
}

// Windows store COLORREF as signed/unsigned decimal: 0x00BBGGRR.
export function colorRefToRgb(v) {
  v = Number(v) >>> 0;
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255];
}

export function rgbToColorRef([r, g, b]) {
  return (b << 16) | (g << 8) | r;
}

export function rgbToCss([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Program schedule fields. Dates are (flag 0x80000000 | days-since-1970); times are seconds from midnight.
export function dayNumberToDate(days) {
  return new Date(Date.UTC(1970, 0, 1) + days * 86400000);
}

export function dateToDayNumber(d) {
  return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1970, 0, 1)) / 86400000);
}

export function isUnlimited(v) {
  return (Number(v) & 0x80000000) !== 0;
}

export function pageKind(page) {
  if (page.long === T.TEXT) return 'text';
  // A canvas page is a media page whose pixels live inline (<cvpng> = base64 PNG) instead of in a file.
  if (page.long === T.MEDIA) return page.has('cvpng') ? 'canvas' : 'media';
  if (page.long === T.DATETIME) return 'datetime';
  return 'other';
}

export function describeNode(n) {
  switch (n.long) {
    case T.PANEL: return `Panel: ${n.great}`;
    case T.PROGRAM: return `Program: ${n.great}`;
    case T.WINDOW: return n.great;
    default: return `${PAGE_TYPE_NAMES[n.long] ?? 'Page ' + n.long}: ${n.great}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Best-effort import of the newer <led595 version="3"> schema (written by later PowerLED releases).
// We map what the editor understands onto the v2 tree; anything else keeps the template default.

function child(el, name) {
  return el.children.find((c) => c.name === name);
}
function ctext(el, name, d = '') {
  const c = el && child(el, name);
  return c ? c.text : d;
}
function hexToSigned(h) {
  return String(parseInt(h, 16) | 0);
}
function hexColorToRef(h) {
  // v3 stores colors as BBGGRR hex (COLORREF), mirroring v2's decimal.
  return String(parseInt(h || '0', 16) >>> 0);
}

function convertV3(doc) {
  const root = new Node(T.ROOT, 'NULL');
  root.slt = 1;
  for (const group of doc.children.filter((c) => c.name === 'group')) {
    for (const screen of group.children.filter((c) => c.name === 'screen')) {
      const panel = fromTemplate(T.PANEL, screen.attrs.name ?? 'Panel1', TEMPLATES.panel);
      panel.slt = 1;
      panel.fore = screen.attrs.select === '0' ? 0 : 1;
      const pc = child(screen, 'panelcfg');
      if (pc) {
        const w = parseInt(ctext(pc, 'width', '128'), 10);
        const h = parseInt(ctext(pc, 'height', '16'), 10);
        setPanelSize(panel, w, h);
        panel.set('pc', ctext(pc, 'colortype', '2'));
        panel.set('pd', ctext(pc, 'datapolar', '0'));
        panel.set('po1', ctext(pc, 'oepolar', '1'));
        panel.set('pf', ctext(pc, 'freq', '5'));
        panel.set('pp', ctext(pc, 'panelid', '1'));
        panel.set('pde', ctext(pc, 'defbaud', '57600'));
      }
      panel.set('pgp', group.attrs.name ?? 'Default');
      for (const prog of screen.children.filter((c) => c.name === 'program')) {
        const p = fromTemplate(T.PROGRAM, prog.attrs.name ?? 'Program1', TEMPLATES.program);
        p.fore = prog.attrs.select === '0' ? 0 : 1;
        const map = {
          playtype: 'pt', playtime: 'time', week: 'wk', frameenable: 'fenable', frametype: 'fp',
          frameaction: 'fa', framestep: 'fs', framespeed: 'fspeed', frameflat: 'fflat',
          framecustomenable: 'fcf', framecustomlimit: 'cfnl', framecustomrange: 'cfnr', framecustompath: 'cfsf',
        };
        for (const [k3, k2] of Object.entries(map)) if (child(prog, k3)) p.set(k2, ctext(prog, k3));
        if (child(prog, 'startdate')) p.set('sd', hexToSigned(ctext(prog, 'startdate')));
        if (child(prog, 'enddate')) p.set('ed', String(parseInt(ctext(prog, 'enddate'), 16)));
        if (child(prog, 'starttime')) p.set('st', hexToSigned(ctext(prog, 'starttime')));
        if (child(prog, 'endtime')) p.set('et', String(parseInt(ctext(prog, 'endtime'), 16)));
        if (child(prog, 'framecustomclear')) p.set('cfcc', hexColorToRef(ctext(prog, 'framecustomclear')));
        for (const win of prog.children.filter((c) => c.name === 'window')) {
          const w = fromTemplate(T.WINDOW, win.attrs.name ?? 'Window1', TEMPLATES.window);
          w.fore = win.attrs.show === '0' ? 0 : 1;
          w.set('rect', win.attrs.size ?? '0,0,128,16');
          for (const page of win.children.filter((c) => c.name === 'page')) {
            const type = parseInt(page.attrs.type ?? '1', 10);
            const pg = fromTemplate(type, page.attrs.name ?? 'Text1', type === T.MEDIA ? TEMPLATES.media : TEMPLATES.text);
            pg.set('action', ctext(page, 'action', '1'));
            pg.set('speed', ctext(page, 'speed', '1'));
            pg.set('delay', ctext(page, 'delay', '100'));
            pg.set('bkcr', hexColorToRef(ctext(page, 'backcolor', '0')));
            pg.set('clear', ctext(page, 'exittype', '0'));
            if (type === T.TEXT) {
              pg.set('rtf', ctext(page, 'rtf'));
              pg.set('sm', ctext(page, 'summary'));
              pg.set('va', ctext(page, 'verticalalign', '1'));
            }
            w.children.push(pg);
          }
          p.children.push(w);
        }
        panel.children.push(p);
      }
      root.children.push(panel);
    }
  }
  return { version: '2', root, sourceFormat: 'v3' };
}
