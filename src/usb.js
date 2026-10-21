// USB export: builds POWERLED/<w><h><colors>.TFU, POWERLED/LED.TFU and POWERLED/Readme.txt.
//
// Format (reverse-engineered from PowerLed.exe and checked against real exports):
//
//   file   = sector(0x200) + stream(N * 0x1000)
//   sector = 512 filler bytes ((rand%128)|0x80) with a few real fields:
//              0x32 u8  (< 0x40)          0x34 u32 stream length         0x38 u32 largest program bitmap bytes
//              0x3c u16 0x59A5            0x40 u16 width, 0x42 u16 height
//              0x46 u8  1,  0x47 u8 0     0x90.. 0x70-byte panel parameter block
//   stream = key(0x80) | u32 programOffset[nProgram] | program records | random padding
//   key    = filler with 0x46=1, 0x7B=0x37+rand%50, 0x7C=rand, 0x7D=0x55-key[7C]-n, 0x7E=rand, 0x7F=n-key[7E]
//   program record = 0x1BC header, then each window's pages
//     header: u16 playTime, u8 playType, u8 week, u32 startDate, endDate, startTime, endTime (unlimited => 0/0xFFFFFFFF),
//             windows[16] at 0xD8 {u32 absoluteOffset, u16 x, y, w, h}, 01 5A 01 00 at 0x198
//   page   = 0x14 header + frames; frame = {u16 delay, u16 0} + planes * rows * stride bytes
//   bitmap = per colour plane (R,G,B), rows padded to 32 px, LSB = leftmost pixel, 1 = LED off
import { T, panelSize, windowRect, pageKind } from './project.js';

export const SECTOR = 0x200;
const STREAM_ALIGN = 0x1000;
const MAX_WINDOWS = 16;
const MAX_PAGES = 200;
const TEXT_TAIL_GAP = 15; // observed: header "text width" = content width of the last frame + 15

const CONTINUOUS_ACTIONS = new Set([3, 5]);

export const README_TEXT =
  'Warning: this folder saved data with PowerLed , Do not modify any data !\r\n' +
  '-------------------------------------------------------------\r\n' +
  '警告，该目录内保存了显示屏播放数据，请勿修改任何内容！';

export function readmeBytes() {
  const out = new Uint8Array(2 + README_TEXT.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < README_TEXT.length; i++) {
    const c = README_TEXT.charCodeAt(i);
    out[2 + i * 2] = c & 255;
    out[3 + i * 2] = c >> 8;
  }
  return out;
}

export const alignBits = (w) => Math.ceil(w / 32) * 32;
export const planeCount = (pc) => Math.max(1, Math.min(3, pc));

// --------------------------------------------------------------------------------------------
// bitmap encoding

// rgba: Uint8ClampedArray (w*h*4). Returns planes*rows*stride bytes.
export function encodePlanes(rgba, w, h, planes) {
  const stride = alignBits(w) / 8;
  const out = new Uint8Array(planes * h * stride).fill(0xff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      for (let p = 0; p < planes; p++) {
        const on = planes === 1 ? Math.max(r, g, b) >= 128 : [r, g, b][p] >= 128;
        if (on) out[p * h * stride + y * stride + (x >> 3)] &= ~(1 << (x & 7));
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------------------------
// panel parameter block (0x70 bytes at sector+0x90). Offsets come from the member layout PowerLed.exe
// uses when it loads/saves the project's panel tags.

// A controller's own LED.TFR (read back from the USB disk) holds the same 0x70-byte block at offset 0x10.
export function configFromTfr(tfr) {
  if (!tfr || tfr.length < 0x80) throw new Error('LED.TFR is too short to contain panel parameters.');
  const b = Uint8Array.from(tfr.slice(0x10, 0x80));
  b.fill(0, 0x1a, 0x20); // MAC address is not exported
  return b;
}

export function buildConfigBlock(panel) {
  const b = new Uint8Array(0x70);
  const dv = new DataView(b.buffer);
  const n = (k, d = 0) => panel.int(k, d);
  dv.setUint32(0x00, n('pde') >>> 0, true);
  dv.setUint16(0x04, n('pp', 1), true);
  dv.setUint16(0x06, n('pw', 128), true);
  dv.setUint16(0x08, n('ph1', 16), true);
  b[0x0a] = n('pc', 2);
  b[0x0b] = n('pd');
  b[0x0c] = n('po1');
  b[0x0d] = n('pl') & 255;
  b[0x0e] = n('pr4');
  b[0x0f] = n('pf');
  b[0x10] = n('ph2');
  b[0x11] = n('ps');
  b[0x12] = n('pwb');
  b[0x13] = n('po2');
  for (let i = 0; i < 4; i++) b[0x14 + i] = n(`pr${i}`);
  dv.setUint16(0x18, n('ilp'), true);
  // 0x1a..0x1f is the controller's MAC address. Real exports carry zeros there, so we do too.
  for (let i = 0; i < 4; i++) {
    b[0x20 + i] = n(`ili${i}`);
    b[0x24 + i] = n(`ilg${i}`);
    b[0x28 + i] = n(`ils${i}`);
    b[0x2c + i] = n(`ilo${i}`);
  }
  b[0x38] = n('ss2');
  b[0x39] = n('ss1');
  b[0x3a] = n('sr0');
  b[0x3b] = n('sr1');
  for (let i = 0; i < 4; i++) {
    dv.setUint16(0x3c + i * 5, n(`si4${i}`), true);
    dv.setUint16(0x3e + i * 5, n(`si2${i}`), true);
    b[0x40 + i * 5] = n(`si5${i}`);
  }
  b[0x50] = n('ll1');
  b[0x51] = n('ll2');
  for (let i = 0; i < 6; i++) {
    dv.setUint16(0x52 + i * 5, n(`ll4${i}`), true);
    dv.setUint16(0x54 + i * 5, n(`ll2${i}`), true);
    b[0x56 + i * 5] = n(`ll5${i}`);
  }
  return b;
}

// --------------------------------------------------------------------------------------------
// model walking

// Returns the programs that will be written plus human-readable notes about anything skipped.
export function collectPrograms(panel) {
  const notes = [];
  const programs = [];
  for (const prog of panel.children.filter((c) => c.long === T.PROGRAM)) {
    if (!prog.enabled) continue;
    const windows = [];
    prog.children.filter((c) => c.long === T.WINDOW).forEach((win, index) => {
      const pages = [];
      for (const page of win.children) {
        if (!page.enabled) continue;
        const kind = pageKind(page);
        if (kind !== 'text' && kind !== 'media' && kind !== 'canvas') {
          notes.push(`${prog.great}: skipped "${page.great}" (page type ${page.long} is not supported for export yet)`);
          continue;
        }
        pages.push(page);
      }
      if (index >= MAX_WINDOWS) {
        if (pages.length) notes.push(`${prog.great}: window ${index + 1} skipped (a program holds at most ${MAX_WINDOWS} windows)`);
        return;
      }
      if (pages.length > MAX_PAGES) {
        notes.push(`${prog.great}: window ${index + 1} limited to ${MAX_PAGES} pages`);
        pages.length = MAX_PAGES;
      }
      windows.push({ index, win, rect: windowRect(win), pages });
    });
    if (windows.some((w) => w.pages.length)) programs.push({ prog, windows });
    else notes.push(`${prog.great}: skipped (no exportable pages)`);
  }
  return { programs, notes };
}

// --------------------------------------------------------------------------------------------
// writer

class Bytes {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(u8) {
    this.chunks.push(u8);
    this.length += u8.length;
  }

  toUint8Array() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function pageRecord(page, r, rasterized, planes) {
  const kind = pageKind(page);
  const frames = rasterized.frames;
  const action = page.int('action', 1);
  const wireAction = action > 5 ? action - 1 : action;
  const continuous = CONTINUOUS_ACTIONS.has(action);
  const delay = continuous ? 0 : Math.min(0xffff, page.int('delay', 100));
  const head = new Uint8Array(0x14);
  const hv = new DataView(head.buffer);
  hv.setUint16(0x04, delay, true);
  head[0x06] = Math.min(255, frames.length);
  head[0x07] = kind === 'text' ? 1 : 2;
  head[0x08] = page.int('clear', 0) & 255;
  head[0x09] = wireAction & 255;
  head[0x0a] = page.int('speed', 1) & 255;
  if (kind === 'text') hv.setUint16(0x0e, Math.min(0xffff, Math.round(rasterized.lastWidth) + TEXT_TAIL_GAP), true);

  const out = new Bytes();
  out.push(head);
  frames.forEach((frame) => {
    const fh = new Uint8Array(4);
    new DataView(fh.buffer).setUint16(0, delay, true);
    out.push(fh);
    out.push(encodePlanes(frame.rgba, r.w, r.h, planes));
  });
  return out.toUint8Array();
}

// Builds the TFU file bytes. `rasterize(page, rect)` -> { frames: [{ rgba }], lastWidth }.
export function buildTfu(panel, { rasterize, rng = Math.random, configOverride = null } = {}) {
  const { width, height } = panelSize(panel);
  const pc = panel.int('pc', 2);
  const planes = planeCount(pc);
  const { programs, notes } = collectPrograms(panel);
  if (!programs.length) throw new Error('Nothing to export: no enabled program with a text or image page.');

  const byte = () => Math.floor(rng() * 256);
  const fill = () => (Math.floor(rng() * 128) | 0x80);

  const nProg = programs.length;
  // ---- program records
  const stream = new Bytes();
  const key = new Uint8Array(0x80);
  for (let i = 0; i < 0x80; i++) key[i] = fill();
  key[0x46] = 1;
  key[0x47] = 0;
  key.fill(0, 0x48, 0x4c);
  key[0x7b] = 0x37 + Math.floor(rng() * 50);
  key[0x7c] = byte();
  key[0x7d] = (0x55 - key[0x7c] - nProg) & 255;
  key[0x7e] = byte();
  key[0x7f] = (nProg - key[0x7e]) & 255;
  stream.push(key);

  const offsetTable = new Uint8Array(4 * nProg);
  stream.push(offsetTable);
  const offsetView = new DataView(offsetTable.buffer);

  let maxBitmapBytes = 0;
  programs.forEach(({ prog, windows }, pi) => {
    offsetView.setUint32(pi * 4, stream.length, true);
    const recordStart = stream.length;
    const hdr = new Uint8Array(0x1bc);
    const hv = new DataView(hdr.buffer);
    hv.setUint16(0, Math.max(3, Math.min(0xffff, prog.int('time', 60))), true);
    hdr[2] = prog.int('pt', 0) & 255;
    hdr[3] = (prog.int('wk', 255) & 0x80) ? 0xff : prog.int('wk', 255) & 255;
    const sd = prog.int('sd') >>> 0, ed = prog.int('ed') >>> 0, st = prog.int('st') >>> 0, et = prog.int('et') >>> 0;
    if (sd & 0x80000000) { hv.setUint32(4, 0, true); hv.setUint32(8, 0xffffffff, true); } else { hv.setUint32(4, sd, true); hv.setUint32(8, ed, true); }
    if (st & 0x80000000) { hv.setUint32(12, 0, true); hv.setUint32(16, 0xffffffff, true); } else { hv.setUint32(12, st, true); hv.setUint32(16, et, true); }
    hdr[0x198] = 0x01; hdr[0x199] = 0x5a; hdr[0x19a] = 0x01;

    let cursor = recordStart + 0x1bc;
    const body = new Bytes();
    let programBitmap = 0;
    for (const { index, rect, pages } of windows) {
      if (!pages.length) continue;
      const entry = 0xd8 + index * 12;
      hv.setUint32(entry, cursor, true);
      hv.setUint16(entry + 4, rect.x, true);
      hv.setUint16(entry + 6, rect.y, true);
      hv.setUint16(entry + 8, rect.w, true);
      hv.setUint16(entry + 10, rect.h, true);
      programBitmap += (rect.h * alignBits(rect.w) * planes) / 8;
      for (const page of pages) {
        const rec = pageRecord(page, rect, rasterize(page, rect), planes);
        body.push(rec);
        cursor += rec.length;
      }
    }
    maxBitmapBytes = Math.max(maxBitmapBytes, programBitmap);
    stream.push(hdr);
    stream.push(body.toUint8Array());
  });

  // ---- pad stream to a multiple of 0x1000 with random bytes
  const used = stream.length;
  const padded = Math.ceil(used / STREAM_ALIGN) * STREAM_ALIGN;
  const pad = new Uint8Array(padded - used);
  for (let i = 0; i < pad.length; i++) pad[i] = byte();
  stream.push(pad);

  // ---- header sector
  const sector = new Uint8Array(SECTOR);
  for (let i = 0; i < SECTOR; i++) sector[i] = fill();
  const sv = new DataView(sector.buffer);
  sector[0x32] = Math.floor(rng() * 0x40);
  sv.setUint32(0x34, padded, true);
  sv.setUint32(0x38, maxBitmapBytes, true);
  sv.setUint16(0x3c, 0x59a5, true);
  sv.setUint16(0x3e, 0, true);
  sv.setUint16(0x40, width, true);
  sv.setUint16(0x42, height, true);
  sector[0x46] = 1;
  sector[0x47] = 0;
  sv.setUint32(0x48, 0, true);
  const cfg = configOverride ? Uint8Array.from(configOverride) : buildConfigBlock(panel);
  if (configOverride) {
    // geometry always follows the project, otherwise the controller would play frames at the wrong size
    const cv = new DataView(cfg.buffer);
    cv.setUint16(0x06, width, true);
    cv.setUint16(0x08, height, true);
    cfg[0x0a] = pc;
  }
  sector.set(cfg, 0x90);

  const file = new Uint8Array(SECTOR + padded);
  file.set(sector, 0);
  file.set(stream.toUint8Array(), SECTOR);
  return { bytes: file, notes, programCount: nProg, name: `${width}${height}${pc}.TFU` };
}

// Returns { files: { 'POWERLED/...': Uint8Array }, notes, summary }.
export function buildUsbExport(project, panel, options = {}) {
  if (!options.rasterize) throw new Error('USB export needs a page rasteriser.');
  const tfu = buildTfu(panel, options);
  return {
    files: {
      [`POWERLED/${tfu.name}`]: tfu.bytes,
      'POWERLED/LED.TFU': tfu.bytes,
      'POWERLED/Readme.txt': readmeBytes(),
    },
    notes: tfu.notes,
    summary: `${tfu.programCount} program(s), ${tfu.bytes.length} bytes`,
  };
}
