import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const page = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');

test('the static site exposes the real workflow and its limits', () => {
  for (const text of ['train', 'eval', 'prototipo local', 'bloquean las escrituras', 'Node.js 24']) {
    assert.ok(page.includes(text), `Missing: ${text}`);
  }
  assert.match(page, /href="https:\/\/github\.com\/dbqp01\/anyweb/);
  assert.equal((page.match(/data-stage="\d"/g) || []).length, 4);
  assert.equal((page.match(/data-panel="\d"/g) || []).length, 4);
  assert.match(page, /Ejemplo ilustrativo, sin conexión a sitios/);
});
