// Minimal XML reader/writer. PowerLED project files only use elements, attributes and text,
// but the RTF payload contains newlines that must survive a round trip untouched.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

export function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}

// Returns { name, attrs, children, text } for the document element.
export function parseXml(src) {
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let i = 0;
  const n = src.length;

  const skipMisc = () => {
    for (;;) {
      if (src.startsWith('<?', i)) i = src.indexOf('?>', i) + 2;
      else if (src.startsWith('<!--', i)) i = src.indexOf('-->', i) + 3;
      else if (src.startsWith('<!', i)) i = src.indexOf('>', i) + 1;
      else if (/\s/.test(src[i] ?? 'x')) i++;
      else return;
    }
  };

  const parseElement = () => {
    if (src[i] !== '<') throw new Error(`XML: expected '<' at ${i}`);
    i++;
    const m = /^[^\s/>]+/.exec(src.slice(i, i + 256));
    if (!m) throw new Error(`XML: bad tag name at ${i}`);
    const el = { name: m[0], attrs: {}, children: [], text: '' };
    i += m[0].length;
    for (;;) {
      while (/\s/.test(src[i])) i++;
      if (src[i] === '/') {
        i += 2; // '/>'
        return el;
      }
      if (src[i] === '>') {
        i++;
        break;
      }
      const am = /^([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(src.slice(i, i + 4096));
      if (!am) throw new Error(`XML: bad attribute at ${i}`);
      el.attrs[am[1]] = decode(am[3] ?? am[4]);
      i += am[0].length;
    }
    for (;;) {
      const lt = src.indexOf('<', i);
      if (lt < 0) throw new Error(`XML: unterminated <${el.name}>`);
      if (lt > i) el.text += decode(src.slice(i, lt));
      i = lt;
      if (src.startsWith('</', i)) {
        const gt = src.indexOf('>', i);
        i = gt + 1;
        return el;
      }
      if (src.startsWith('<![CDATA[', i)) {
        const end = src.indexOf(']]>', i);
        el.text += src.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (src.startsWith('<!--', i)) {
        i = src.indexOf('-->', i) + 3;
        continue;
      }
      el.children.push(parseElement());
    }
  };

  skipMisc();
  const root = parseElement();
  if (i > n) throw new Error('XML: ran past end');
  return root;
}

// Element with only text and no children is written as <a>text</a>; empty text -> <a/>.
export function writeElement(el) {
  const attrs = Object.entries(el.attrs ?? {})
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join('');
  const kids = el.children ?? [];
  if (!kids.length && !el.text) return `<${el.name}${attrs}/>`;
  return `<${el.name}${attrs}>${escapeText(el.text ?? '')}${kids.map(writeElement).join('')}</${el.name}>`;
}
