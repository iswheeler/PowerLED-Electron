// Preview engine: rasterises pages (text/media/date-time), plays windows through the entry effects and
// draws the result as an LED dot matrix. Browser-only (uses <canvas>).
import { parseRtf, DEFAULT_FS } from './rtf.js';
import {
  T, colorRefToRgb, rgbToCss, windowRect, panelSize, panelColorType, pageKind,
} from './project.js';
import { A, CONTINUOUS, drawEntry, entryDuration, pickRandomAction } from './effects.js';

const mk = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

// Milliseconds per pixel step for a given <speed> value; 1 is the fastest setting.
export const stepMs = (speed) => 10 * Math.max(1, speed);

const FONT_FALLBACK = { System: 'Arial', Terminal: 'Courier New', 'Fixedsys': 'Courier New' };

function cssFont(run) {
  const px = ((run.fs ?? DEFAULT_FS) / 2) * (96 / 72);
  const family = FONT_FALLBACK[run.font] ?? run.font ?? 'Arial';
  return { px, font: `${run.i ? 'italic ' : ''}${run.b ? 'bold ' : ''}${px}px "${family}", Arial, sans-serif` };
}

// Split paragraphs into styled tokens so we can wrap at word boundaries (and between CJK glyphs).
function tokens(run) {
  return run.text.match(/\n|[ \t]+|[^\s⺀-鿿＀-￯]+|[⺀-鿿＀-￯]/g) ?? [];
}

function layout(ctx, doc, maxWidth, wrap) {
  const lines = [];
  for (const para of doc.paras) {
    let line = { items: [], width: 0, px: 0, asc: 0, align: para.align };
    const newLine = () => {
      lines.push(line);
      line = { items: [], width: 0, px: 0, asc: 0, align: para.align };
    };
    for (const run of para.runs) {
      const { px, font } = cssFont(run);
      ctx.font = font;
      const metrics = ctx.measureText('Hg');
      const asc = metrics.fontBoundingBoxAscent ?? px * 0.9;
      for (const tok of tokens(run)) {
        if (tok === '\n') {
          newLine();
          continue;
        }
        const text = tok === '\t' ? '    ' : tok;
        const width = ctx.measureText(text).width;
        if (wrap && line.width + width > maxWidth && line.items.length && !/^\s+$/.test(text)) newLine();
        if (wrap && !line.items.length && /^\s+$/.test(text)) continue; // no leading blanks after a wrap
        line.items.push({ text, font, color: run.color, u: run.u, width, px, asc });
        line.width += width;
        line.px = Math.max(line.px, px);
        line.asc = Math.max(line.asc, asc);
      }
      if (!para.runs.length) line.px = Math.max(line.px, px);
    }
    if (!line.px) line.px = ((DEFAULT_FS / 2) * 96) / 72;
    newLine();
  }
  return lines;
}

const WHITE = [255, 255, 255];

// Draws `lines` into a fresh canvas with crisp (non anti-aliased) pixels, as LEDs are on or off.
function paintLines(lines, w, h, { bg, valign, lineGap }) {
  const layer = mk(w, h);
  const ctx = layer.getContext('2d', { willReadFrequently: true });
  const heights = lines.map((l) => Math.ceil(l.px * 1.2) + lineGap);
  const total = heights.reduce((a, b) => a + b, 0);
  let y = valign === 2 ? h - total : valign === 1 ? Math.floor((h - total) / 2) : 0;
  lines.forEach((line, k) => {
    let x = line.align === 'c' ? (w - line.width) / 2 : line.align === 'r' ? w - line.width : 0;
    const base = y + Math.round((heights[k] - lineGap - line.px * 1.2) / 2) + line.asc;
    for (const it of line.items) {
      ctx.font = it.font;
      ctx.fillStyle = rgbToCss(it.color ?? WHITE);
      ctx.fillText(it.text, x, base);
      if (it.u) ctx.fillRect(Math.round(x), Math.round(base + 1), Math.round(it.width), 1);
      x += it.width;
    }
    y += heights[k];
  });
  // threshold the anti-aliased edges
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 110 ? 255 : 0;
  ctx.putImageData(img, 0, 0);

  const out = mk(w, h);
  const octx = out.getContext('2d');
  octx.fillStyle = rgbToCss(bg);
  octx.fillRect(0, 0, w, h);
  octx.drawImage(layer, 0, 0);
  return out;
}

// Returns an array of canvases: one per "page" of text (text taller than the window flows onto more pages).
// Continuous-move effects get a single wide strip instead.
export function rasterizeText(page, w, h, { forExport = false } = {}) {
  const doc = parseRtf(page.get('rtf'));
  const bg = colorRefToRgb(page.int('bkcr', 0));
  const valign = page.int('va', 1);
  const lineGap = page.int('line', 0);
  const probe = mk(1, 1).getContext('2d');
  const action = page.int('action', 1);

  if (CONTINUOUS.has(action)) {
    const lines = layout(probe, doc, Infinity, false);
    const joined = lines.reduce((acc, l) => {
      acc.items.push(...l.items);
      if (!forExport) acc.items.push({ text: '   ', font: l.items[0]?.font ?? '12px Arial', color: null, u: false, width: 0, px: l.px, asc: l.asc });
      acc.width += l.width;
      acc.px = Math.max(acc.px, l.px);
      acc.asc = Math.max(acc.asc, l.asc);
      return acc;
    }, { items: [], width: 0, px: 0, asc: 0, align: 'l' });
    const strip = Math.max(1, Math.ceil(joined.width));
    return { strip: true, contentWidth: strip, canvases: [paintLines([joined], strip, h, { bg, valign, lineGap })] };
  }

  const lines = layout(probe, doc, w, true);
  const lh = lines.map((l) => Math.ceil(l.px * 1.2) + lineGap);
  const pages = [];
  let cur = [];
  let used = 0;
  lines.forEach((l, k) => {
    if (cur.length && used + lh[k] > h) {
      pages.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(l);
    used += lh[k];
  });
  pages.push(cur);
  const lastLines = pages[pages.length - 1];
  const contentWidth = Math.ceil(Math.max(0, ...lastLines.map((l) => l.width)));
  return { strip: false, contentWidth, canvases: pages.map((ls) => paintLines(ls, w, h, { bg, valign, lineGap })) };
}

export function rasterizeMedia(page, w, h, getImage) {
  const out = mk(w, h);
  const ctx = out.getContext('2d');
  const [fr, fg, fb] = colorRefToRgb(page.int('bkcr', 0));
  ctx.fillStyle = `rgb(${fr},${fg},${fb})`;
  ctx.fillRect(0, 0, w, h);
  const isCanvas = page.has('cvpng');
  const img = getImage(isCanvas ? `data:image/png;base64,${page.get('cvpng')}` : page.get('ip04'));
  if (!img) {
    ctx.fillStyle = '#c33';
    ctx.font = '8px Arial';
    if (!isCanvas) ctx.fillText('no image', 1, 9);
    return { strip: false, canvases: [out] };
  }
  ctx.imageSmoothingEnabled = true;
  const mode = page.int('ip01', 0);
  if (mode === 1) ctx.drawImage(img, Math.round((w - img.width) / 2), Math.round((h - img.height) / 2));
  else if (mode === 2) {
    for (let y = 0; y < h; y += img.height) for (let x = 0; x < w; x += img.width) ctx.drawImage(img, x, y);
  } else ctx.drawImage(img, 0, 0, w, h);
  return { strip: false, canvases: [out] };
}

function rasterizeClock(page, w, h, now) {
  const out = mk(w, h);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  const pad = (n) => String(n).padStart(2, '0');
  const kind = page.long;
  const label = kind === T.DATETIME
    ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
    : `[${page.great}]`;
  let px = Math.max(6, Math.min(h - 2, 14));
  ctx.font = `${px}px Arial`;
  while (px > 6 && ctx.measureText(label).width > w) ctx.font = `${--px}px Arial`;
  ctx.fillStyle = kind === T.DATETIME ? '#ff0' : '#888';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, Math.max(0, (w - ctx.measureText(label).width) / 2), h / 2);
  return { strip: false, canvases: [out] };
}

// ---------------------------------------------------------------------------------------------
// Playback

class WindowRuntime {
  constructor(win, getImage, now) {
    this.win = win;
    this.rect = windowRect(win);
    this.getImage = getImage;
    this.now = now;
    this.pages = win.children.filter((c) => c.enabled);
    this.pageIdx = 0;
    this.sub = 0;
    this.cycles = 0;
    this.last = mk(this.rect.w, this.rect.h); // what the window currently shows once idle
    this.cur = null;
    this.t = 0;
    this.begin();
  }

  rasterize(page) {
    const { w, h } = this.rect;
    switch (pageKind(page)) {
      case 'text': return rasterizeText(page, w, h);
      case 'media': case 'canvas': return rasterizeMedia(page, w, h, this.getImage);
      default: return rasterizeClock(page, w, h, this.now());
    }
  }

  begin() {
    const { w, h } = this.rect;
    if (!this.pages.length || !w || !h) {
      this.cur = null;
      return;
    }
    const page = this.pages[this.pageIdx];
    const r = this.rasterize(page);
    const next = r.canvases[Math.min(this.sub, r.canvases.length - 1)];
    let action = page.int('action', 1);
    if (action === A.RANDOM) action = pickRandomAction();
    const speed = stepMs(page.int('speed', 1));
    const strip = r.strip && CONTINUOUS.has(action);
    this.cur = {
      page, next, action, strip, subCount: r.canvases.length,
      enter: strip ? (w + next.width) * speed : entryDuration(action, w, h, speed),
      hold: strip ? 0 : page.int('delay', 100) * 10,
      speedMs: speed,
    };
    if (pageKind(page) === 'datetime') this.cur.hold = Math.max(this.cur.hold, 1000);
    this.t = 0;
  }

  advance() {
    const c = this.cur;
    if (c) this.last = c.strip ? mk(this.rect.w, this.rect.h) : c.next;
    if (c && this.sub + 1 < c.subCount) this.sub++;
    else {
      this.sub = 0;
      this.pageIdx++;
      if (this.pageIdx >= this.pages.length) {
        this.pageIdx = 0;
        this.cycles++;
      }
    }
    this.begin();
  }

  tick(dt) {
    const c = this.cur;
    if (!c) return;
    this.t += dt;
    // a clock page re-rasterises so the seconds keep moving while held
    if (pageKind(c.page) === 'datetime' && this.t > c.enter) {
      const fresh = this.rasterize(c.page).canvases[0];
      c.next = fresh;
    }
    if (this.t >= c.enter + c.hold) this.advance();
  }

  draw(ctx) {
    const c = this.cur;
    const { x, y, w, h } = this.rect;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.translate(x, y);
    if (c) {
      if (c.strip) {
        if (this.t < c.enter) {
          const travel = w + c.next.width;
          const p = this.t / c.enter;
          const right = c.action === A.MOVE_RIGHT_CONT;
          const ox = right ? -c.next.width + p * travel : w - p * travel;
          ctx.drawImage(this.last, 0, 0);
          ctx.drawImage(c.next, Math.round(ox), 0);
        } else ctx.drawImage(this.last, 0, 0);
      } else if (this.t < c.enter) {
        drawEntry(ctx, w, h, c.action, this.t / c.enter, this.last, c.next);
      } else ctx.drawImage(c.next, 0, 0);
    }
    ctx.restore();
  }
}

export class Player {
  // panel: the 120-node; getImage(path) -> HTMLImageElement|null
  constructor(panel, { getImage = () => null, now = () => new Date(), programs = null } = {}) {
    this.panel = panel;
    this.getImage = getImage;
    this.now = now;
    const { width, height } = panelSize(panel);
    this.W = width;
    this.H = height;
    this.frame = mk(width, height);
    this.programs = programs ?? panel.children.filter((p) => p.long === T.PROGRAM && p.enabled);
    this.progIdx = 0;
    this.startProgram();
  }

  startProgram() {
    this.elapsed = 0;
    this.windows = [];
    if (!this.programs.length) return;
    const prog = this.programs[this.progIdx % this.programs.length];
    this.program = prog;
    this.windows = prog.children
      .filter((w) => w.long === T.WINDOW)
      .map((w) => new WindowRuntime(w, this.getImage, this.now));
  }

  get programName() {
    return this.program?.great ?? '';
  }

  tick(dt) {
    if (!this.windows.length) return;
    this.elapsed += dt;
    for (const w of this.windows) w.tick(dt);
    const timed = this.program.int('pt', 0) === 1;
    const done = timed
      ? this.elapsed >= this.program.int('time', 60) * 1000
      : this.windows.every((w) => w.cycles >= 1 || !w.pages.length);
    if (done && (this.programs.length > 1 || timed)) {
      this.progIdx = (this.progIdx + 1) % this.programs.length;
      this.startProgram();
    } else if (done) {
      // single program, default order: loop it from the top
      this.startProgram();
    }
  }

  // Composes the current frame into this.frame and returns it.
  render() {
    const ctx = this.frame.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    for (const w of this.windows) w.draw(ctx);
    applyColorType(ctx, this.W, this.H, panelColorType(this.panel));
    return this.frame;
  }
}

// Static (non-animated) view used while editing: every window shows its first enabled page, except that
// `pickPage` may choose another one (e.g. the page currently selected in the tree).
export function renderStaticProgram(panel, program, { pickPage = () => null, getImage = () => null, now = () => new Date() } = {}) {
  const { width, height } = panelSize(panel);
  const frame = mk(width, height);
  const ctx = frame.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  for (const win of program?.children ?? []) {
    if (win.long !== T.WINDOW) continue;
    const rt = new WindowRuntime(win, getImage, now);
    const page = pickPage(win) ?? rt.pages[0];
    if (!page || !rt.rect.w || !rt.rect.h) continue;
    const r = rt.rasterize(page);
    ctx.drawImage(r.canvases[0], rt.rect.x, rt.rect.y);
  }
  applyColorType(ctx, width, height, panelColorType(panel));
  return frame;
}

// The controller stores one 1-bit plane per colour (pc = number of planes: 1 = R, 2 = RG, 3 = RGB), so every
// channel is either on or off. Showing the same thing in the preview keeps it identical to the exported data.
export function quantizeToPlanes(d, planes) {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (planes <= 1) {
      d[i] = Math.max(r, g, b) >= 128 ? 255 : 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
    } else {
      d[i] = r >= 128 ? 255 : 0;
      d[i + 1] = g >= 128 ? 255 : 0;
      d[i + 2] = planes >= 3 && b >= 128 ? 255 : 0;
    }
  }
}

function applyColorType(ctx, w, h, pc) {
  const img = ctx.getImageData(0, 0, w, h);
  quantizeToPlanes(img.data, Math.max(1, Math.min(3, pc)));
  ctx.putImageData(img, 0, 0);
}

// Rasterises one page at window size for the USB exporter: returns { frames: [{ rgba }], lastWidth }.
// Continuous-move text is one long strip, cut into window-wide frames like PowerLed does.
export function rasterizePageForExport(page, rect, getImage) {
  const { w, h } = rect;
  const kind = pageKind(page);
  const r = kind === 'text' ? rasterizeText(page, w, h, { forExport: true }) : rasterizeMedia(page, w, h, getImage);
  if (kind === 'canvas' && !getImage(`data:image/png;base64,${page.get('cvpng')}`)) throw new Error(`Canvas "${page.great}" has not finished loading.`);
  let canvases = r.canvases;
  let lastWidth = r.contentWidth ?? 0;
  if (r.strip) {
    const strip = canvases[0];
    const n = Math.max(1, Math.ceil(strip.width / w));
    canvases = [];
    for (let k = 0; k < n; k++) {
      const c = mk(w, h);
      c.getContext('2d').drawImage(strip, -k * w, 0);
      canvases.push(c);
    }
    lastWidth = strip.width - (n - 1) * w;
  }
  return {
    frames: canvases.map((c) => ({ rgba: c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data })),
    lastWidth,
  };
}

// ---------------------------------------------------------------------------------------------
// LED dot-matrix output

const spriteCache = new Map();

function dotSprites(pitch) {
  const key = pitch;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const r = pitch * 0.42;
  const mask = mk(pitch, pitch); // opaque black with a round hole
  const m = mask.getContext('2d');
  m.fillStyle = '#000';
  m.fillRect(0, 0, pitch, pitch);
  m.globalCompositeOperation = 'destination-out';
  m.beginPath();
  m.arc(pitch / 2, pitch / 2, r, 0, Math.PI * 2);
  m.fill();
  const off = mk(pitch, pitch); // dim unlit LED
  const o = off.getContext('2d');
  o.fillStyle = '#000';
  o.fillRect(0, 0, pitch, pitch);
  o.fillStyle = '#1b1b1b';
  o.beginPath();
  o.arc(pitch / 2, pitch / 2, r, 0, Math.PI * 2);
  o.fill();
  const out = { mask, off };
  spriteCache.set(key, out);
  return out;
}

// Paints `frame` (panel-resolution canvas) onto `target`, one round LED per pixel.
export function drawLedPanel(target, frame, pitch) {
  const w = frame.width * pitch;
  const h = frame.height * pitch;
  if (target.width !== w) target.width = w;
  if (target.height !== h) target.height = h;
  const ctx = target.getContext('2d');
  const { mask, off } = dotSprites(pitch);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = ctx.createPattern(off, 'repeat');
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'lighten';
  ctx.drawImage(frame, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = ctx.createPattern(mask, 'repeat');
  ctx.fillRect(0, 0, w, h);
}
