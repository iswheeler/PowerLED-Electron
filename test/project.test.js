import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, serializeProject, newProject, panels, panelSize, T } from '../src/project.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Real-world files are optional: point POWERLED_SAMPLES at a folder of .ledprj files to include them.
const sampleRoot = process.env.POWERLED_SAMPLES ?? path.join(here, '../../..');
const dirs = [path.join(here, '../examples'), sampleRoot, path.join(sampleRoot, '../PowerLed')];
const samples = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.ledprj')).map((f) => path.join(d, f)) : []));

for (const f of samples) {
  test(`v2 round trip is byte-exact: ${path.basename(f)}`, (t) => {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes('<project ver="2"')) return t.skip('not a v2 file');
    assert.equal(serializeProject(parseProject(text)), text);
  });
}

test('v3 (led595) files import into the v2 tree', () => {
  const f = path.join(sampleRoot, '../PowerLed/default.ledprj');
  if (!fs.existsSync(f)) return;
  const text = fs.readFileSync(f, 'utf8');
  if (!text.includes('<led595')) return;
  const p = parseProject(text);
  const panel = panels(p)[0];
  assert.ok(panel);
  assert.ok(panelSize(panel).width > 0);
  assert.equal(panel.children[0].children[0].children[0].long, T.TEXT);
  // re-serialises into something we can parse again
  assert.equal(panels(parseProject(serializeProject(p))).length, panels(p).length);
});

test('new project serialises and re-parses identically', () => {
  const p = newProject();
  const text = serializeProject(p);
  assert.equal(serializeProject(parseProject(text)), text);
  const panel = panels(p)[0];
  assert.deepEqual(panelSize(panel), { width: 128, height: 16 });
});
