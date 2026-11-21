import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { saveSite, siteFile } from '../src/artifact/site.mjs';
import { startFixture, products } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });

test('review executes a proposed tool live and persists approval without raw input', { timeout: 60000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-review-'));
  const env = { WEB2API_HOME: home };
  t.after(() => fixture.close());
  const detail = name => products.find(product => product.name === name);
  const traces = ['Laptop Pro', 'Laptop Air'].map(product_name => ({
    input: { product_name },
    calls: [
      { origin: fixture.origin, path: '/api/products', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200, response: { products } },
      { origin: fixture.origin, path: '/api/product', method: 'GET', encoding: 'query', params: { id: detail(product_name).id }, status: 200, response: detail(product_name) },
    ],
  }));
  const approved = [
    { origin: fixture.origin, path: '/api/products', method: 'GET', success: {} },
    { origin: fixture.origin, path: '/api/product', method: 'GET', success: {} },
  ];
  const recipe = compileRecipe({ id: 'product_detail', traces, approvedRequests: approved });
  await saveSite({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'product_detail', goal: 'Look up a product by exact name', effect: 'read', status: 'proposed', input_fields: ['product_name'],
      approved_requests: approved, recipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null }],
    evidence: { actions: 4, requests_observed: 8, compiled_at: new Date().toISOString(), engine_hash: 'a'.repeat(64) },
  }, env);

  const result = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(result.exitCode, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.approved, 1);
  assert.equal(payload.tools[0].status, 'approved');
  assert.match(result.stderr, /step 1: GET/);
  assert.match(result.stderr, /passed in/);

  const site = JSON.parse(await readFile(siteFile(fixture.origin, env), 'utf8'));
  assert.equal(site.tools[0].status, 'approved');
  assert.equal(site.tools[0].verification.status, 'passed');
  assert.ok(site.tools[0].reviewed_at);
  assert.match(site.tools[0].verification.hashes.review, /^[a-f0-9]{64}$/);
  assert.match(site.tools[0].verification.hashes.review_digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(site).includes('Laptop Pro'), false);
  const again = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(JSON.parse(again.stdout).reviewed, 0);
  site.tools[0].goal = 'Look up a product by reviewed name';
  await saveSite(site, env);
  const stale = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(stale.exitCode, 0, stale.stdout);
  assert.equal(JSON.parse(stale.stdout).reviewed, 1);
  const refreshed = JSON.parse(await readFile(siteFile(fixture.origin, env), 'utf8'));
  assert.notEqual(refreshed.tools[0].verification.hashes.review_digest, site.tools[0].verification.hashes.review_digest);
});
