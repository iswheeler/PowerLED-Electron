// Small RTF reader/writer covering the subset PowerLED's rich-edit control emits:
// paragraphs, alignment, bold/italic/underline, text colour, font face and size.
//
// Document model:
//   { paras: [ { align: 'l'|'c'|'r', runs: [ { text, b, i, u, color: [r,g,b]|null, fs, font } ] } ] }
// `fs` is in RTF half-points (fs20 == 10pt).

export const DEFAULT_FS = 24; // RTF default is 12pt
const CODEPAGES = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252' };

function decodeBytes(bytes, cpg) {
  try {
    return new TextDecoder(CODEPAGES[cpg] ?? 'windows-1252').decode(Uint8Array.from(bytes));
  } catch {
    return String.fromCharCode(...bytes);
  }
}

export function emptyDoc() {
  return { paras: [] };
}

export function parseRtf(src) {
  const fonts = new Map();
  const colors = [];
  let cpg = 1252;
  let uc = 1;
  const defaults = { b: false, i: false, u: false, cf: 0, f: 0, fs: DEFAULT_FS };
  let st = { ...defaults, align: 'l', mode: 'text' };
  const stack = [];
  const paras = [];
  let cur = { align: 'l', runs: [] };
  let fontIdx = 0;
  let fontBuf = '';
  let color = { r: 0, g: 0, b: 0, has: false };
  let pendingBytes = [];
  let skipChars = 0;

  const flushBytes = () => {
    if (pendingBytes.length) {
      emit(decodeBytes(pendingBytes, cpg));
      pendingBytes = [];
    }
  };

  function emit(text) {
    if (st.mode !== 'text' || !text) return;
    const fmt = {
      b: st.b, i: st.i, u: st.u, color: colors[st.cf] ?? null, fs: st.fs, font: fonts.get(st.f) ?? null,
    };
    const last = cur.runs[cur.runs.length - 1];
    if (last && last.b === fmt.b && last.i === fmt.i && last.u === fmt.u && last.fs === fmt.fs && last.font === fmt.font &&
      JSON.stringify(last.color) === JSON.stringify(fmt.color)) {
      last.text += text;
    } else {
      cur.runs.push({ text, ...fmt });
    }
  }

  const endPara = () => {
    paras.push(cur);
    cur = { align: st.align, runs: [] };
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '{') {
      flushBytes();
      stack.push(st);
      st = { ...st };
      i++;
      // `{\*` marks an optional destination we do not understand
      if (src[i] === '\\' && src[i + 1] === '*') st.mode = 'skip';
    } else if (ch === '}') {
      flushBytes();
      if (st.mode === 'fonttbl' && fontBuf.trim()) {
        fonts.set(fontIdx, fontBuf.trim().replace(/;$/, ''));
        fontBuf = '';
      }
      st = stack.pop() ?? st;
      i++;
    } else if (ch === '\\') {
      i++;
      const c = src[i];
      if (c === "'") {
        const hex = src.substr(i + 1, 2);
        i += 3;
        if (skipChars > 0) skipChars--;
        else if (st.mode === 'text') pendingBytes.push(parseInt(hex, 16));
        continue;
      }
      flushBytes();
      if (!/[a-zA-Z]/.test(c ?? '')) {
        i++;
        if (c === '\\' || c === '{' || c === '}') {
          if (skipChars > 0) skipChars--;
          else emit(c);
        } else if (c === '~') emit('\u00a0');
        else if (c === '_') emit('-');
        else if (c === '\n' || c === '\r') endPara();
        continue;
      }
      let j = i;
      while (/[a-zA-Z]/.test(src[j] ?? '')) j++;
      const word = src.slice(i, j);
      let k = j;
      if (src[k] === '-') k++;
      while (/\d/.test(src[k] ?? '')) k++;
      const param = k > j ? parseInt(src.slice(j, k), 10) : null;
      i = k;
      if (src[i] === ' ') i++; // delimiter space is consumed
      applyControl(word, param);
    } else if (ch === '\r' || ch === '\n') {
      i++; // raw line breaks are not significant in RTF
    } else {
      i++;
      if (skipChars > 0) {
        skipChars--;
        continue;
      }
      if (st.mode === 'fonttbl') {
        if (ch === ';') {
          fonts.set(fontIdx, fontBuf.trim());
          fontBuf = '';
        } else fontBuf += ch;
      } else if (st.mode === 'colortbl') {
        if (ch === ';') {
          colors.push(color.has ? [color.r, color.g, color.b] : null);
          color = { r: 0, g: 0, b: 0, has: false };
        }
      } else emit(ch);
    }
  }
  flushBytes();
  if (cur.runs.length) paras.push(cur);

  function applyControl(word, p) {
    switch (word) {
      case 'ansicpg': cpg = p; break;
      case 'uc': uc = p ?? 1; break;
      case 'fonttbl': st.mode = 'fonttbl'; break;
      case 'colortbl': st.mode = 'colortbl'; break;
      case 'stylesheet': case 'info': case 'pict': case 'header': case 'footer': case 'generator':
        st.mode = 'skip'; break;
      case 'red': color.r = p; color.has = true; break;
      case 'green': color.g = p; color.has = true; break;
      case 'blue': color.b = p; color.has = true; break;
      case 'f':
        if (st.mode === 'fonttbl') {
          fontIdx = p;
          fontBuf = '';
        } else st.f = p;
        break;
      case 'fs': st.fs = p; break;
      case 'cf': st.cf = p; break;
      case 'b': st.b = p !== 0; break;
      case 'i': st.i = p !== 0; break;
      case 'ul': st.u = p !== 0; break;
      case 'ulnone': st.u = false; break;
      case 'plain': Object.assign(st, defaults); break;
      case 'pard': st.align = 'l'; cur.align = 'l'; break;
      case 'ql': st.align = 'l'; cur.align = 'l'; break;
      case 'qc': st.align = 'c'; cur.align = 'c'; break;
      case 'qr': st.align = 'r'; cur.align = 'r'; break;
      case 'qj': st.align = 'l'; cur.align = 'l'; break;
      case 'par': if (st.mode === 'text') endPara(); break;
      case 'line': emit('\n'); break;
      case 'tab': emit('\t'); break;
      case 'u': {
        const code = p < 0 ? p + 65536 : p;
        emit(String.fromCharCode(code));
        skipChars = uc;
        break;
      }
      default: break;
    }
  }

  return { paras };
}

export function plainText(doc) {
  return doc.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}

export function summary(doc) {
  return plainText(doc).replace(/\s+/g, ' ').trim();
}

function escapeRtf(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (ch === '\n') out += '\\line ';
    else if (ch === '\t') out += '\\tab ';
    else if (c < 32) continue;
    else if (c < 128) out += ch;
    else if (c < 0x10000) out += `\\u${c > 32767 ? c - 65536 : c}?`;
    else {
      const hi = 0xd800 + ((c - 0x10000) >> 10);
      const lo = 0xdc00 + ((c - 0x10000) & 0x3ff);
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

export function generateRtf(doc) {
  const fontList = [];
  const colorList = [];
  const fontIndex = (name) => {
    name = name || 'Arial';
    let k = fontList.indexOf(name);
    if (k < 0) k = fontList.push(name) - 1;
    return k;
  };
  const colorIndex = (c) => {
    if (!c) return 0;
    const key = c.join(',');
    let k = colorList.findIndex((x) => x.join(',') === key);
    if (k < 0) k = colorList.push(c) - 1;
    return k + 1;
  };
  fontIndex(doc.paras[0]?.runs[0]?.font);

  let body = '';
  let cf = 0, f = 0, fs = DEFAULT_FS, b = false, it = false, u = false;
  for (const p of doc.paras) {
    body += '\\pard' + (p.align === 'c' ? '\\qc' : p.align === 'r' ? '\\qr' : '');
    let first = true;
    for (const r of p.runs) {
      let ctl = '';
      const ncf = colorIndex(r.color);
      const nf = fontIndex(r.font);
      const nfs = r.fs ?? DEFAULT_FS;
      if (ncf !== cf) ctl += `\\cf${(cf = ncf)}`;
      if (!!r.b !== b) ctl += (b = !!r.b) ? '\\b' : '\\b0';
      if (!!r.i !== it) ctl += (it = !!r.i) ? '\\i' : '\\i0';
      if (!!r.u !== u) ctl += (u = !!r.u) ? '\\ul' : '\\ulnone';
      if (nf !== f) ctl += `\\f${(f = nf)}`;
      if (nfs !== fs) ctl += `\\fs${(fs = nfs)}`;
      // a trailing space terminates the last control word; it is never text
      body += ctl + ' ' + escapeRtf(r.text);
      first = false;
    }
    if (first) body += ' ';
    body += '\\par\n';
  }

  const fontTbl = fontList.map((name, k) => `{\\f${k}\\fnil\\fcharset0 ${name};}`).join('');
  const colorTbl = colorList.map(([r, g, bl]) => `\\red${r}\\green${g}\\blue${bl};`).join('');
  return (
    `{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1033{\\fonttbl${fontTbl}}\n` +
    `{\\colortbl ;${colorTbl}}\n` +
    `\\viewkind4\\uc1${body}}\n`
  );
}

export function simpleDoc(text, { color = [255, 0, 0], fs = 20, font = 'Arial', align = 'l', b = false } = {}) {
  return {
    paras: text.split('\n').map((line) => ({ align, runs: line ? [{ text: line, b, i: false, u: false, color, fs, font }] : [] })),
  };
}
