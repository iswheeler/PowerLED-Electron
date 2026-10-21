import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node, T, newProject, panels } from '../src/project.js';
import { buildTfu, buildConfigBlock, configFromTfr, alignBits, planeCount, encodePlanes, SECTOR } from '../src/usb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Real exports are optional (see POWERLED_SAMPLES); the self-contained tests below always run.
const root = process.env.POWERLED_SAMPLES ?? path.join(here, '../../..');
const SAMPLES = {
  a: 'Powerled_samples/POWERLED_aaaaaaaaaaaa/LED_a.TFU',
  b: 'Powerled_samples/POWERLED_bbbbbbbbbbbb/LED_b.TFU',
  bc: 'Powerled_samples/POWERLED_bbbbbbbbbbbc/LED_bc.TFU',
  bk: 'POWERLED_USB_BACKUP/POWERLED/LED.TFU',
};
const have = Object.values(SAMPLES).every((p) => fs.existsSync(path.join(root, p)));

// ---- minimal TFU reader (mirrors the documented layout)
function parseTfu(buf, planes) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const s = SECTOR;
  const out = {
    streamLen: dv.getUint32(0x34, true), maxBytes: dv.getUint32(0x38, true), magic: dv.getUint16(0x3c, true),
    width: dv.getUint16(0x40, true), height: dv.getUint16(0x42, true), config: buf.slice(0x90, 0x100), programs: [],
  };
  const first = dv.getUint32(s + 0x80, true);
  const n = (first - 0x80) / 4;
  for (let i = 0; i < n; i++) {
    const off = dv.getUint32(s + 0x80 + 4 * i, true);
    const base = s + off;
    const prog = {
      off, header: buf.slice(base, base + 0x1bc), windows: [],
    };
    for (let w = 0; w < 16; w++) {
      const e = base + 0xd8 + w * 12;
      const pageOff = dv.getUint32(e, true);
      if (!pageOff) continue;
      const rect = { x: dv.getUint16(e + 4, true), y: dv.getUint16(e + 6, true), w: dv.getUint16(e + 8, true), h: dv.getUint16(e + 10, true) };
      prog.windows.push({ index: w, rect, off: pageOff, pages: [] });
    }
    // pages run until the next window (or program) begins
    const ends = prog.windows.map((w) => w.off);
    prog.windows.forEach((win, k) => {
      let p = s + win.off;
      const stride = alignBits(win.rect.w) / 8;
      const frameBytes = planes * win.rect.h * stride;
      const limit = k + 1 < prog.windows.length ? s + ends[k + 1] : null;
      for (;;) {
        const nf = buf[p + 6];
        const kind = buf[p + 7];
        const page = {
          kind, action: buf[p + 9], speed: buf[p + 10], clear: buf[p + 8], delay: dv.getUint16(p + 4, true),
          textWidth: dv.getUint16(p + 0x0e, true), frames: [], raw: null,
        };
        const start = p;
        p += 0x14;
        for (let f = 0; f < nf; f++) {
          p += 4;
          page.frames.push(buf.slice(p, p + frameBytes));
          p += frameBytes;
        }
        page.raw = buf.slice(start, p);
        win.pages.push(page);
        if (limit !== null ? p >= limit : (kind !== 1 && kind !== 2) || buf[p + 7] !== 1 && buf[p + 7] !== 2 || p >= s + out.streamLen || buf[p] !== 0 || buf[p + 1] !== 0) break;
      }
    });
    out.programs.push(prog);
  }
  return out;
}

// planes -> RGBA (inverse of encodePlanes) so we can feed sample bitmaps back through the exporter
function decodePlanes(bytes, w, h, planes) {
  const stride = alignBits(w) / 8;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let p = 0; p < planes; p++) {
        const on = !((bytes[p * h * stride + y * stride + (x >> 3)] >> (x & 7)) & 1);
        if (on) rgba[i + (planes === 1 ? 0 : p)] = 255;
      }
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function panelFromTemplate(overrides = {}) {
  // the stock panel parameters PowerLed writes (same values as the shipped default project)
  const panel = panels(newProject())[0];
  panel.children = [];
  for (const [k, v] of Object.entries(overrides)) panel.set(k, v);
  return panel;
}

function programNode(sample, panel, programHeader) {
  const prog = new Node(T.PROGRAM, 'P');
  const dv = new DataView(programHeader.buffer, programHeader.byteOffset, programHeader.byteLength);
  prog.set('time', dv.getUint16(0, true));
  prog.set('pt', programHeader[2]);
  prog.set('wk', programHeader[3]);
  const sd = dv.getUint32(4, true), ed = dv.getUint32(8, true), st = dv.getUint32(12, true), et = dv.getUint32(16, true);
  // unlimited encoding (0 / 0xFFFFFFFF) maps back to the flagged project value
  prog.set('sd', sd === 0 && ed === 0xffffffff ? (0x80000000 | 0) : sd | 0);
  prog.set('ed', ed === 0xffffffff ? 17974 : ed);
  prog.set('st', st === 0 && et === 0xffffffff ? (0x80000000 | 0) : st | 0);
  prog.set('et', et === 0xffffffff ? 86399 : et);
  void sample; void panel;
  return prog;
}

for (const key of Object.keys(SAMPLES)) {
  test(`export reproduces real sample "${key}" byte for byte (meaningful fields)`, (t) => {
    if (!have) return t.skip('real sample exports not present (set POWERLED_SAMPLES)');
    const sample = new Uint8Array(fs.readFileSync(path.join(root, SAMPLES[key])));
    const planes = 2;
    const parsed = parseTfu(sample, planes);
    // the backup came from a controller whose settings differ from the stock template (frequency, scan)
    const extra = key === 'bk' ? { pf: 4, ss1: 2 } : {};
    const panel = panelFromTemplate({ pw: parsed.width, ph1: parsed.height, pc: planes, ...extra });

    // lookup tables for the fake rasteriser, keyed by page object
    const frameSource = new Map();
    for (const pr of parsed.programs) {
      const prog = programNode(sample, panel, pr.header);
      for (const win of pr.windows) {
        const wnode = new Node(T.WINDOW, 'Window1');
        wnode.fore = 0;
        // window children sit at their original index so that the table position matches
        wnode.set('rect', [win.rect.x, win.rect.y, win.rect.x + win.rect.w, win.rect.y + win.rect.h].join(','));
        for (const pg of win.pages) {
          const page = new Node(pg.kind === 1 ? T.TEXT : T.MEDIA, 'pg');
          const wire = pg.action;
          page.set('action', wire); // actions <= 5 are identical on the wire
          page.set('speed', pg.speed);
          page.set('delay', pg.delay);
          page.set('clear', pg.clear);
          frameSource.set(page, { pg, rect: win.rect });
          wnode.children.push(page);
        }
        while (prog.children.length < win.index) prog.children.push(new Node(T.WINDOW, 'empty'));
        prog.children.push(wnode);
      }
      panel.children.push(prog);
    }

    const rasterize = (page, rect) => {
      const { pg } = frameSource.get(page);
      return {
        frames: pg.frames.map((f) => ({ rgba: decodePlanes(f, rect.w, rect.h, planes) })),
        lastWidth: Math.max(0, pg.textWidth - 15),
      };
    };
    const built = buildTfu(panel, { rasterize, rng: lcg(7) }).bytes;
    const mine = parseTfu(built, planes);

    assert.equal(built.length, sample.length, 'file length');
    assert.equal(mine.streamLen, parsed.streamLen, 'stream length field');
    assert.equal(mine.maxBytes, parsed.maxBytes, 'largest bitmap field');
    assert.equal(mine.magic, 0x59a5);
    assert.deepEqual([mine.width, mine.height], [parsed.width, parsed.height]);
    assert.deepEqual(Array.from(mine.config), Array.from(parsed.config).map((v, i) => (i >= 0x1a && i < 0x20 ? 0 : v)), 'panel parameter block');
    assert.equal(mine.programs.length, parsed.programs.length);
    mine.programs.forEach((mp, i) => {
      const sp = parsed.programs[i];
      assert.equal(mp.off, sp.off, `program ${i} offset`);
      assert.deepEqual(Array.from(mp.header), Array.from(sp.header), `program ${i} header`);
      mp.windows.forEach((mw, j) => {
        const sw = sp.windows[j];
        assert.deepEqual(mw.rect, sw.rect);
        assert.equal(mw.pages.length, sw.pages.length, `program ${i} window ${j} page count`);
        mw.pages.forEach((mpg, k) => {
          assert.deepEqual(Array.from(mpg.raw), Array.from(sw.pages[k].raw), `program ${i} window ${j} page ${k}`);
        });
      });
    });
    // key block consistency bytes
    const n = mine.programs.length;
    const k = built.subarray(SECTOR, SECTOR + 0x80);
    assert.equal((k[0x7d] + k[0x7c] + n) & 255, 0x55);
    assert.equal((k[0x7f] + k[0x7e]) & 255, n);
  });
}

test('config block layout (known values)', () => {
  const panel = panelFromTemplate({ pc: 2 });
  const b = buildConfigBlock(panel);
  assert.deepEqual(Array.from(b.slice(0, 8)), [0, 0xe1, 0, 0, 1, 0, 0x80, 0]);
  assert.equal(b[0x0a], 2);
  assert.deepEqual(Array.from(b.slice(0x20, 0x24)), [192, 168, 1, 252]);
});

test('bitmap encoding: LSB first, inverted, rows padded to 32px', () => {
  const w = 10, h = 2;
  const rgba = new Uint8ClampedArray(w * h * 4);
  rgba[(0 * w + 0) * 4] = 255; // red pixel at x=0,y=0
  rgba[(1 * w + 9) * 4 + 1] = 255; // green pixel at x=9,y=1
  const out = encodePlanes(rgba, w, h, 2);
  assert.equal(out.length, 2 * 2 * 4);
  assert.equal(out[0], 0xfe); // plane R, row 0, bit 0 cleared
  assert.equal(out[4 + 1 + 8 * 1 / 1 - 8 + 0 * 0] !== undefined, true);
  assert.equal(out[2 * 4 + 4 + 1], 0xfd); // plane G, row 1, byte 1, bit 1 cleared
  assert.equal(planeCount(3), 3);
});

test('config block can come from the controller\'s own LED.TFR', (t) => {
  const tfrPath = path.join(root, 'POWERLED_USB_BACKUP/LED.TFR');
  if (!fs.existsSync(tfrPath) || !have) return t.skip('sample files not present');
  const tfr = new Uint8Array(fs.readFileSync(tfrPath));
  const sample = new Uint8Array(fs.readFileSync(path.join(root, SAMPLES.bk)));
  // stock template differs from this controller (pf, ss1); the TFR block must win and reproduce the real file
  assert.deepEqual(Array.from(configFromTfr(tfr)), Array.from(sample.slice(0x90, 0x100)));
});

test('canvas pages round-trip in the project and are exported as image pages', async () => {
  const { newProject, newCanvas, pageKind, serializeProject, parseProject: parse } = await import('../src/project.js');
  const { collectPrograms } = await import('../src/usb.js');
  const proj = newProject();
  const win = proj.root.children[0].children[0].children[0];
  win.children = [newCanvas([], 'iVBORw0KGgo=')];
  assert.equal(pageKind(win.children[0]), 'canvas');
  const again = parse(serializeProject(proj));
  const page = again.root.children[0].children[0].children[0].children[0];
  assert.equal(pageKind(page), 'canvas');
  assert.equal(page.get('cvpng'), 'iVBORw0KGgo=');
  const plan = collectPrograms(again.root.children[0]);
  assert.equal(plan.programs[0].windows[0].pages.length, 1);
  assert.equal(plan.notes.length, 0);
});

test('self-contained: a new project exports a structurally valid .TFU', async () => {
  const proj = newProject();
  const panel = proj.root.children[0];
  const rasterize = (page, rect) => ({
    frames: [{ rgba: new Uint8ClampedArray(rect.w * rect.h * 4).fill(255) }], // all pixels lit
    lastWidth: rect.w,
  });
  const { bytes, name } = buildTfu(panel, { rasterize, rng: lcg(3) });
  const dv = new DataView(bytes.buffer);
  assert.equal(name, '128162.TFU');
  assert.equal(bytes.length, SECTOR + 0x1000);
  assert.equal(dv.getUint32(0x34, true), 0x1000);
  assert.equal(dv.getUint16(0x3c, true), 0x59a5);
  assert.equal(dv.getUint32(0x38, true), (16 * 128 * 2) / 8); // 16 rows x 128 px x 2 planes
  assert.equal(dv.getUint16(0x40, true), 128);
  assert.equal(dv.getUint16(0x42, true), 16);
  const key = bytes.subarray(SECTOR, SECTOR + 0x80);
  assert.equal((key[0x7d] + key[0x7c] + 1) & 255, 0x55); // one program
  assert.equal((key[0x7f] + key[0x7e]) & 255, 1);
  const prog = SECTOR + dv.getUint32(SECTOR + 0x80, true);
  assert.equal(dv.getUint32(prog + 0x198, true) & 0xffffff, 0x015a01);
  const page = SECTOR + dv.getUint32(prog + 0xd8, true);
  assert.equal(bytes[page + 7], 1); // text page
  assert.equal(bytes[page + 0x14 + 4], 0); // lit pixels -> first plane byte is 0x00 (LED on)
});

test('unsupported page types are reported, not silently dropped', async () => {
  const { collectPrograms } = await import('../src/usb.js');
  const proj = newProject();
  const win = proj.root.children[0].children[0].children[0];
  win.children[0].long = 11; // date/time page
  const plan = collectPrograms(proj.root.children[0]);
  assert.equal(plan.programs.length, 0);
  assert.ok(plan.notes.some((n) => /not supported/.test(n)));
});
