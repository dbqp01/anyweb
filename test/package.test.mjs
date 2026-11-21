import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { saveSite, siteFile } from '../src/artifact/site.mjs';
import { startFixture, products } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const envOf = extra => Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([, value]) => value !== undefined));

test('package bundles approved tools into a standalone MCP server', { timeout: 120000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-package-'));
  const downloads = await mkdtemp(join(tmpdir(), 'web2api-downloads-'));
  const env = { WEB2API_HOME: home };
  t.after(() => fixture.close());
  const detail = name => products.find(product => product.name === name);

  const readTraces = ['Laptop Pro', 'Laptop Air'].map(product_name => ({
    input: { product_name },
    calls: [
      { origin: fixture.origin, path: '/api/products', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200, response: { products } },
      { origin: fixture.origin, path: '/api/product', method: 'GET', encoding: 'query', params: { id: detail(product_name).id }, status: 200, response: detail(product_name) },
    ],
  }));
  const downloadTraces = ['spec', 'manual'].map(file_name => {
    const bytes = Buffer.byteLength(`PDF:${file_name}`);
    return {
      input: { file_name },
      calls: [{ origin: fixture.origin, path: '/api/file', method: 'GET', encoding: 'query', params: { name: file_name }, status: 200,
        response_meta: { content_type: 'application/pdf', bytes, sha256: createHash('sha256').update(`PDF:${file_name}`).digest('hex') } }],
    };
  });
  const readApproved = [
    { origin: fixture.origin, path: '/api/products', method: 'GET', success: {} },
    { origin: fixture.origin, path: '/api/product', method: 'GET', success: {} },
  ];
  const downloadApproved = [{ origin: fixture.origin, path: '/api/file', method: 'GET', success: {} }];
  const readRecipe = compileRecipe({ id: 'product_detail', traces: readTraces, approvedRequests: readApproved });
  const downloadRecipe = compileRecipe({ id: 'product_file', effect: 'download', traces: downloadTraces, approvedRequests: downloadApproved });
  await saveSite({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [
      { id: 'product_detail', goal: 'Look up a product by exact name', effect: 'read', status: 'proposed', input_fields: ['product_name'],
        approved_requests: readApproved, recipe: readRecipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null },
      { id: 'product_file', goal: 'Download a product file by name', effect: 'download', status: 'proposed', input_fields: ['file_name'],
        approved_requests: downloadApproved, recipe: downloadRecipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null },
    ],
    evidence: { actions: 8, requests_observed: 10, compiled_at: new Date().toISOString(), engine_hash: 'b'.repeat(64) },
  }, env);

  const review = await cli(['review', '--site', fixture.origin, '--yes', '--input',
    JSON.stringify({ product_detail: { product_name: 'Laptop Pro' }, product_file: { file_name: 'spec' } })], env);
  assert.equal(review.exitCode, 0, review.stdout);
  const packaged = await cli(['package', '--site', fixture.origin], env);
  assert.equal(packaged.exitCode, 0, packaged.stdout);
  const payload = JSON.parse(packaged.stdout);
  assert.deepEqual(payload.tools.sort(), ['product_detail', 'product_file']);
  assert.equal(JSON.stringify(JSON.parse(await readFile(siteFile(fixture.origin, env), 'utf8'))).includes('Laptop Pro'), false);
  const code = await readFile(payload.bundle, 'utf8');
  assert.equal(/\bplaywright\b/i.test(code), false);
  const snippet = JSON.parse(await readFile(payload.snippet, 'utf8'));
  assert.deepEqual(snippet.mcpServers['anyweb-fixture'], { command: process.execPath, args: [payload.bundle], env: { WEB2API_HOME: home } });
  const evidence = JSON.parse(await readFile(payload.evidence, 'utf8'));
  assert.equal(JSON.stringify(evidence).includes('Laptop'), false);
  await access(payload.bundle);

  const client = new Client({ name: 'package-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [payload.bundle], env: envOf({ WEB2API_DOWNLOADS: downloads }), stderr: 'pipe' }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['product_detail', 'product_file']);
  const readHints = listed.tools.find(tool => tool.name === 'product_detail').annotations;
  const downloadHints = listed.tools.find(tool => tool.name === 'product_file').annotations;
  assert.equal(readHints.readOnlyHint, true);
  assert.equal(readHints.openWorldHint, true);
  assert.equal(downloadHints.readOnlyHint, false);
  assert.equal(downloadHints.idempotentHint, false);
  assert.equal(downloadHints.openWorldHint, true);

  const read = await client.callTool({ name: 'product_detail', arguments: { product_name: 'Laptop Air' } });
  assert.ok(!read.isError, JSON.stringify(read));
  const readPayload = JSON.parse(read.content[0].text);
  assert.equal(readPayload.data.name, 'Laptop Air');
  assert.equal(readPayload.evidence.steps_completed, 2);

  const download = await client.callTool({ name: 'product_file', arguments: { file_name: 'manual' } });
  assert.ok(!download.isError, JSON.stringify(download));
  const file = JSON.parse(download.content[0].text).file;
  assert.ok(file.path.startsWith(downloads));
  assert.equal(await readFile(file.path, 'utf8'), 'PDF:manual');
  assert.match(file.sha256, /^[a-f0-9]{64}$/);

  const invalid = await client.callTool({ name: 'product_detail', arguments: {} });
  assert.equal(invalid.isError, true);
});
