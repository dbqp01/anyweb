import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';
import { startFixture } from './fixtures/server.mjs';
import { redact, redactUrl } from '../src/redact.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const DEMO_SECRET = 'DEMO-ONLY-NOT-A-REAL-CREDENTIAL';

test('session-key names are redacted in captured objects, URLs and maps', () => {
  assert.deepEqual(redact({ sesskey: DEMO_SECRET }), { sesskey: '[REDACTED]' });
  assert.deepEqual(redact(new Map([['apiKey', DEMO_SECRET]])), [['apiKey', '[REDACTED]']]);
  assert.equal(redactUrl(`https://example.com/api?sesskey=${DEMO_SECRET}`).includes(DEMO_SECRET), false);
});

test('compilation rejects session keys in captured requests', () => {
  const origin = 'https://example.com';
  const trace = q => ({ input: { q }, calls: [{ origin, path: '/api/search', method: 'GET', encoding: 'query',
    params: { q, sesskey: DEMO_SECRET }, status: 200, response: { query: q } }] });
  assert.throws(() => compileRecipe({ id: 'search', traces: [trace('a'), trace('b')],
    approvedRequests: [{ origin, path: '/api/search', method: 'GET', success: {} }] }), /SECRET_IN_RECIPE/);
});

test('compilation refuses an API key in a captured request', () => {
  const origin = 'https://example.com';
  const trace = q => ({ input: { q }, calls: [{ origin, path: '/api/search', method: 'GET', encoding: 'query',
    params: { q, api_key: DEMO_SECRET }, status: 200, response: { query: q } }] });
  assert.throws(() => compileRecipe({ id: 'search', traces: [trace('a'), trace('b')],
    approvedRequests: [{ origin, path: '/api/search', method: 'GET', success: {} }] }), /SECRET_IN_RECIPE/);
});

test('evidence and step events do not disclose query credentials even in legacy recipes', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const traces = ['Laptop Pro', 'Laptop Air'].map(q => ({ input: { q }, calls: [{ origin: fixture.origin, path: '/api/search',
    method: 'GET', encoding: 'query', params: { q }, status: 200, response: { query: q, products: [{ id: 'p', name: q }] } }] }));
  const approved = [{ origin: fixture.origin, path: '/api/search', method: 'GET', success: {} }];
  const recipe = compileRecipe({ id: 'search', traces, approvedRequests: approved });
  recipe.steps[0].params.access_token = { kind: 'literal', value: DEMO_SECRET };
  const events = [];
  const run = createRecipeRunner(recipe, approved, { allowLoopback: true, onStep: event => events.push(event) });
  const result = await run({ q: 'Laptop' });
  assert.equal(JSON.stringify(result.evidence).includes(DEMO_SECRET), false);
  assert.equal(JSON.stringify(events).includes(DEMO_SECRET), false);
  assert.match(result.evidence.calls[0].url, /REDACTED/);
});

test('a live response never exposes credential fields in MCP output or step events', async t => {
  const server = createServer((request, response) => {
    const q = new URL(request.url, 'http://localhost').searchParams.get('q');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: [{ name: q, api_key: DEMO_SECRET }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const approved = [{ origin, path: '/search', method: 'GET', success: {} }];
  const traces = ['alpha', 'beta'].map(q => ({ input: { q }, calls: [{ origin, path: '/search', method: 'GET', encoding: 'query',
    params: { q }, status: 200, response: { items: [{ name: q, api_key: '[REDACTED]' }] } }] }));
  const recipe = compileRecipe({ id: 'search', traces, approvedRequests: approved });
  const events = [];
  const result = await createRecipeRunner(recipe, approved, { allowLoopback: true, onStep: event => events.push(event) })({ q: 'gamma' });
  assert.equal(result.data.items[0].api_key, '[REDACTED]');
  assert.equal(JSON.stringify({ result, events }).includes(DEMO_SECRET), false);
});
