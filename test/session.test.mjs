import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { saveSite, siteFile } from '../src/artifact/site.mjs';
import { writeSession } from '../src/session.mjs';
import { startFixture, products } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const parse = result => JSON.parse(result.stdout);
const storage = { cookies: [{ name: 'sid', value: 'letmein', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] };

test('explore loads a saved session and status/clear report it', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-session-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env);
    await fixture.close();
  });
  const file = await writeSession(fixture.origin, storage, env);
  const status = parse(await cli(['session', 'status', '--site', fixture.origin], env));
  assert.equal(status.exists, true);
  assert.equal(status.cookies, 1);
  assert.equal(JSON.stringify(status).includes('letmein'), false);

  const started = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', `${fixture.origin}/private`, '--session', 'default'], env));
  assert.ok(started.port > 0, started.error);
  const snapshot = parse(await cli(['explore', 'snapshot', '--site', fixture.origin], env));
  assert.match(snapshot.snapshot, /Private area/);
  await cli(['explore', 'stop', '--site', fixture.origin], env);

  const cleared = parse(await cli(['session', 'clear', '--site', fixture.origin], env));
  assert.equal(cleared.cleared, true);
  assert.equal(JSON.parse(await readFile(file, 'utf8').catch(() => 'null')), null);
  const anon = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', `${fixture.origin}/private`], env));
  assert.ok(anon.port > 0, anon.error);
  assert.match(parse(await cli(['explore', 'snapshot', '--site', fixture.origin], env)).snapshot, /Unauthorized/);

  const login = await cli(['session', 'login', '--site', fixture.origin], env);
  assert.equal(login.exitCode, 1);
  assert.equal(parse(login).error, 'TTY_REQUIRED');
});

test('review runs a session recipe and fails without the session file', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-session-review-'));
  const env = { WEB2API_HOME: home };
  t.after(() => fixture.close());
  const detail = name => products.find(product => product.name === name);
  const traces = ['Laptop Pro', 'Laptop Air'].map(product_name => ({
    input: { product_name },
    calls: [
      { origin: fixture.origin, path: '/api/private/products', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200, response: { products } },
      { origin: fixture.origin, path: '/api/private/product', method: 'GET', encoding: 'query', params: { id: detail(product_name).id }, status: 200, response: detail(product_name) },
    ],
  }));
  const approved = [
    { origin: fixture.origin, path: '/api/private/products', method: 'GET', success: {} },
    { origin: fixture.origin, path: '/api/private/product', method: 'GET', success: {} },
  ];
  const recipe = compileRecipe({ id: 'private_detail', traces, approvedRequests: approved, session: 'default' });
  await saveSite({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: 'default',
    tools: [{ id: 'private_detail', goal: 'Look up a private product by name', effect: 'read', status: 'proposed', input_fields: ['product_name'],
      approved_requests: approved, recipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null }],
    evidence: { actions: 4, requests_observed: 8, compiled_at: new Date().toISOString(), engine_hash: 'c'.repeat(64) },
  }, env);

  const denied = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(denied.exitCode, 1);
  assert.equal(parse(denied).error, 'REAUTH_REQUIRED');
  await writeSession(fixture.origin, storage, env);
  const reviewed = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(reviewed.exitCode, 0, reviewed.stdout);
  assert.equal(parse(reviewed).approved, 1);
  const saved = await readFile(siteFile(fixture.origin, env), 'utf8');
  assert.equal(saved.includes('letmein'), false);
});
