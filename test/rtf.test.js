import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRtf, generateRtf, summary, simpleDoc } from '../src/rtf.js';

const GO_BLUE = '{\\rtf1\\ansi\\ansicpg936\\deff0\\deflang1033\\deflangfe2052{\\fonttbl{\\f0\\fnil\\fcharset0 System;}}\n{\\colortbl ;\\red255\\green255\\blue0;}\n\\viewkind4\\uc1\\pard\\qc\\cf1\\b\\f0\\fs20 GO BLUE\\lang2052\\par\n}\n';

test('parses the stock GO BLUE rtf', () => {
  const d = parseRtf(GO_BLUE);
  assert.equal(d.paras.length, 1);
  assert.equal(d.paras[0].align, 'c');
  const r = d.paras[0].runs[0];
  assert.deepEqual([r.text, r.b, r.fs, r.font, r.color], ['GO BLUE', true, 20, 'System', [255, 255, 0]]);
  assert.equal(summary(d), 'GO BLUE');
});

test('generate -> parse round trip keeps formatting', () => {
  const d = {
    paras: [
      { align: 'r', runs: [
        { text: 'Hi ', b: true, i: false, u: false, color: [255, 0, 0], fs: 24, font: 'Tahoma' },
        { text: 'there {x}\\', b: false, i: true, u: true, color: [0, 255, 0], fs: 16, font: 'Arial' },
      ] },
      { align: 'l', runs: [] },
      { align: 'l', runs: [{ text: 'é日本', b: false, i: false, u: false, color: null, fs: 20, font: 'Arial' }] },
    ],
  };
  const back = parseRtf(generateRtf(d));
  assert.equal(back.paras.length, 3);
  assert.deepEqual(back.paras[0].runs, d.paras[0].runs);
  assert.equal(back.paras[0].align, 'r');
  assert.equal(back.paras[1].runs.length, 0);
  assert.equal(back.paras[2].runs[0].text, 'é日本');
});

test('decodes \\\'hh bytes using the declared code page', () => {
  const d = parseRtf("{\\rtf1\\ansi\\ansicpg936\\deff0 \\'c4\\'e3\\'ba\\'c3\\par}");
  assert.equal(d.paras[0].runs[0].text, '你好');
});

test('simpleDoc builds multi-paragraph documents', () => {
  assert.equal(parseRtf(generateRtf(simpleDoc('a\nb'))).paras.length, 2);
});
