import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSite } from '../src/commands/init.mjs';

const declaration = { version: 1, origin: 'https://example.com', name: 'example', tools: [
  { id: 'search_items', goal: 'Find items matching a query', input_fields: ['query'] },
] };

test('init validates declarations and never overwrites an existing site', async t => {
  const root = await mkdtemp(join(tmpdir(), 'anyweb-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'declaration.json');
  const env = { WEB2API_HOME: join(root, 'home') };
  await writeFile(file, JSON.stringify(declaration));
  const result = await initSite({ file }, env);
  const original = await readFile(result.file, 'utf8');
  assert.deepEqual(result.tools, ['search_items']);
  assert.equal(JSON.parse(original).tools[0].effect, 'read');
  await assert.rejects(initSite({ file }, env), { code: 'SITE_ALREADY_EXISTS' });
  assert.equal(await readFile(result.file, 'utf8'), original);
  await writeFile(file, JSON.stringify({ ...declaration, origin: 'https://example.org/path' }));
  await assert.rejects(initSite({ file }, env), { code: 'INVALID_INPUT' });
  await writeFile(file, JSON.stringify({ ...declaration, tools: [{ ...declaration.tools[0], input_fields: ['query', 'query'] }] }));
  await assert.rejects(initSite({ file }, env), { code: 'INVALID_INPUT' });
  await writeFile(file, '{');
  await assert.rejects(initSite({ file }, env), { code: 'INVALID_DECLARATION_JSON' });
  await assert.rejects(initSite({ file: join(root, 'missing.json') }, env), { code: 'DECLARATION_NOT_FOUND' });
});
