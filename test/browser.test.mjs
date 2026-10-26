import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { compileBrowserRecipe, browserRecipeSchema } from '../src/artifact/browser.mjs';
import { createBrowserRunner } from '../src/browser/runner.mjs';
import { draftSiteSchema } from '../src/artifact/site.mjs';
import { proposeBrowser } from '../src/commands/propose-browser.mjs';
import { startFixture } from './fixtures/server.mjs';

const extract = { mode: 'object', root: '#browser-detail', fields: { id: { attr: 'data-id' }, name: { selector: 'h1' }, price: { selector: '.price' } } };
const demonstration = (origin, name, id, price, role = 'train') => ({
  role, input: { product_name: name },
  requests: [{ method: 'GET', url: `${origin}/browser`, status: 200 }],
  browser_actions: [
    { action: 'open', url: `${origin}/browser` },
    { action: 'type', locator: { kind: 'css', value: '[id="browser-query"]' }, text: name, submit: false },
    { action: 'click', locator: { kind: 'role', role: 'button', name: 'Search' } },
    { action: 'click', locator: { kind: 'role', role: 'button', name } },
  ],
  browser_output: { id, name, price },
});
const buildRecipe = origin => compileBrowserRecipe({ id: 'browser_detail', input_fields: ['product_name'], extract,
  marks: [demonstration(origin, 'Laptop Pro', 'p1', '1200'), demonstration(origin, 'Laptop Air', 'p2', '900')] });
const approved = origin => [{ origin, path: '/browser', method: 'GET', success: {} }];

test('browser compiler learns text and target names while refusing inconsistent or unbound demonstrations', () => {
  const recipe = buildRecipe('https://example.com');
  assert.deepEqual(recipe.steps[1].text, { kind: 'input', field: 'product_name' });
  assert.deepEqual(recipe.steps[3].locator.name, { kind: 'input', field: 'product_name' });
  assert.equal(JSON.stringify(recipe).includes('Laptop'), false);
  const marks = [demonstration('https://example.com', 'Laptop Pro', 'p1', '1200'), demonstration('https://example.com', 'Laptop Air', 'p2', '900')];
  marks[1].browser_actions[2].locator.name = 'Find';
  assert.throws(() => compileBrowserRecipe({ id: 'browser_detail', input_fields: ['product_name'], extract, marks }), { code: 'UNBOUND_BROWSER_VALUE' });
  assert.equal(browserRecipeSchema.safeParse({ ...recipe, checks: [] }).success, false);
  assert.equal(browserRecipeSchema.safeParse({ ...recipe, steps: [{ action: 'press', key: 'Enter' }] }).success, false);
  assert.equal(draftSiteSchema.safeParse({ version: 1, origin: 'https://example.com', name: 'example',
    tools: [{ id: 'browser_detail', goal: 'Read a product', input_fields: ['product_name'], execution: 'browser' }] }).success, false);
});

test('browser runner reads computed DOM for unseen input in an isolated session', { timeout: 45000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const run = createBrowserRunner(buildRecipe(fixture.origin), approved(fixture.origin), { allowLoopback: true });
  assert.deepEqual((await run({ product_name: 'Tablet Mini' })).data, { id: 'p4', name: 'Tablet Mini', price: '350' });
  assert.ok(fixture.requests.every(request => request.path === '/browser'));
  await assert.rejects(run({ product_name: 'Nonexistent' }), { code: 'BROWSER_STEP_FAILED' });
  await assert.rejects(run({}), { code: 'INVALID_INPUT' });
});

test('browser held-out output must match independently of training', { timeout: 45000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const marks = [demonstration(fixture.origin, 'Laptop Pro', 'p1', '1200'), demonstration(fixture.origin, 'Laptop Air', 'p2', '900'),
    demonstration(fixture.origin, 'Phone Max', 'p3', 'WRONG', 'eval')];
  await assert.rejects(proposeBrowser({ id: 'browser_detail', input_fields: ['product_name'], extract }, marks,
    { origin: fixture.origin, allowed_origins: [], session: null }, null), { code: 'VERIFICATION_FAILED', role: 'eval' });
});

test('browser rejects network writes, unreviewed paths and redirects before reaching destinations', { timeout: 45000 }, async t => {
  for (const scenario of ['write', 'unreviewed', 'redirect']) await t.test(scenario, async t => {
    const received = [];
    const server = createServer((request, response) => {
      received.push(request.url);
      if (scenario === 'redirect') { response.writeHead(302, { location: '/unreviewed' }); return response.end(); }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<div id="browser-detail"><h1>alpha</h1></div><script>fetch('/unreviewed', {method:'${scenario === 'write' ? 'POST' : 'GET'}'})</script>`);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const recipe = { ...buildRecipe(origin), steps: [{ action: 'open', url: `${origin}/browser` }] };
    const run = createBrowserRunner(recipe, approved(origin), { allowLoopback: true });
    await assert.rejects(run({ product_name: 'alpha' }), { code: scenario === 'redirect' ? 'BROWSER_REDIRECT_UNSUPPORTED' : 'UNREVIEWED_OPERATION' });
    assert.deepEqual(received, ['/browser']);
  });
});

test('browser runner refuses unsafe policies and missing sessions before execution', () => {
  const origin = 'https://example.com';
  const recipe = buildRecipe(origin);
  assert.throws(() => createBrowserRunner({ ...recipe, session: 'default' }, approved(origin)), { code: 'REAUTH_REQUIRED' });
  assert.throws(() => createBrowserRunner(recipe, [{ ...approved(origin)[0], method: 'POST' }]), { code: 'BROWSER_READ_ONLY' });
  assert.throws(() => createBrowserRunner(recipe, [], {}), { code: 'UNREVIEWED_OPERATION' });
  assert.throws(() => createBrowserRunner(recipe, approved(origin), { session: { headers: { Authorization: 'test-only' } } }), { code: 'BROWSER_STORAGE_STATE_REQUIRED' });
});

test('browser rejects a result whose previously required field has disappeared', { timeout: 20000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<article id="browser-detail" data-id="p1"><h1>alpha</h1></article>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const recipe = { ...buildRecipe(origin), steps: [{ action: 'open', url: `${origin}/browser` }] };
  assert.ok(recipe.required_fields.includes('price'));
  await assert.rejects(createBrowserRunner(recipe, approved(origin), { allowLoopback: true })({ product_name: 'alpha' }), { code: 'VERIFICATION_FAILED' });
});

test('browser loads saved cookie state and reports authentication failures', { timeout: 20000 }, async t => {
  const server = createServer((request, response) => {
    if (request.headers.cookie !== 'session=test-value') { response.writeHead(401); return response.end(); }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<article id="browser-detail" data-id="p1"><h1>alpha</h1><span class="price">1200</span></article>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const recipe = { ...buildRecipe(origin), session: 'default', steps: [{ action: 'open', url: `${origin}/browser` }] };
  await assert.rejects(createBrowserRunner(recipe, approved(origin), { allowLoopback: true, session: { cookies: [], origins: [] } })({ product_name: 'alpha' }), { code: 'REAUTH_REQUIRED' });
  const session = { cookies: [{ name: 'session', value: 'test-value', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] };
  const result = await createBrowserRunner(recipe, approved(origin), { allowLoopback: true, session })({ product_name: 'alpha' });
  assert.equal(result.data.name, 'alpha');
  assert.equal(JSON.stringify(result).includes('test-value'), false);
});
