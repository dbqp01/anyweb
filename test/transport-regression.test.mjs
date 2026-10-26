import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder } from '../src/explore/recorder.mjs';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';

test('recorder separates JSON request data from response and redacts credentials', async () => {
  const handlers = {};
  const recorder = createRecorder({ on: (event, handler) => { handlers[event] = handler; } });
  await handlers.response({
    request: () => ({ headers: () => ({ 'content-type': 'application/json' }), postDataBuffer: () => Buffer.from(JSON.stringify({ q: 'alpha', password: 'private' })), method: () => 'POST', resourceType: () => 'fetch' }),
    headers: () => ({ 'content-type': 'application/json' }), body: async () => Buffer.from('{"items":["alpha"]}'),
    url: () => 'https://example.com/search', status: () => 200,
  });
  const entry = recorder.since(0)[0];
  assert.equal(entry.request_body.q, 'alpha');
  assert.notEqual(entry.request_body.password, 'private');
  assert.deepEqual(entry.body, { items: ['alpha'] });
});

test('runner scopes cookies and refuses unscoped headers across origins', async t => {
  const origin = 'https://api.example.com';
  const approved = [{ origin, path: '/api/search', method: 'GET', success: {} }];
  const traces = ['alpha', 'beta'].map(q => ({ input: { q }, calls: [{ origin, path: '/api/search', method: 'GET', encoding: 'query', params: { q }, status: 200, response: { items: [{ name: q }] } }] }));
  const recipe = compileRecipe({ id: 'search_items', traces, approvedRequests: approved });
  const cookie = (name, overrides = {}) => ({ name, value: 'v', domain: 'api.example.com', path: '/', expires: -1, secure: true, ...overrides });
  const session = { cookies: [cookie('host'), cookie('parent', { domain: '.example.com' }), cookie('wrong', { domain: 'example.com' }), cookie('suffix', { domain: '.ample.com' }), cookie('path', { path: '/api/searching' }), cookie('expired', { expires: 1 }), cookie('other', { domain: 'other.example.com' })] };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers.cookie, 'host=v; parent=v');
    return new Response(JSON.stringify({ items: [{ name: new URL(url).searchParams.get('q') }] }), { headers: { 'content-type': 'application/json' } });
  });
  await createRecipeRunner(recipe, approved, { session })({ q: 'alpha' });
  const extra = { ...recipe.steps[0], origin: 'https://other.example.com' };
  assert.throws(() => createRecipeRunner({ ...recipe, steps: [...recipe.steps, extra] }, [...approved, { ...approved[0], origin: extra.origin }], { session: { headers: { Authorization: 'private' } } }), /SESSION_HEADERS_UNSCOPED/);
});
