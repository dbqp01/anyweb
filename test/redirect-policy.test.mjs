import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';

test('a redirect cannot reach a same-origin path that was not reviewed', async t => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    if (request.url.startsWith('/start')) { response.writeHead(302, { location: '/danger?confirm=1' }); return response.end(); }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<li>alpha</li>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const approved = [{ origin, path: '/start', method: 'GET', success: {} }];
  const extract = { mode: 'list', root: 'li', fields: { name: {} } };
  const traces = ['alpha', 'beta'].map(q => ({ input: { q }, calls: [{ origin, path: '/start', method: 'GET', encoding: 'query',
    params: { q }, status: 200, response_kind: 'html', response: { items: [{ name: q }] } }] }));
  const recipe = compileRecipe({ id: 'search_items', traces, approvedRequests: approved, extract });
  await assert.rejects(createRecipeRunner(recipe, approved, { allowLoopback: true })({ q: 'alpha' }), { code: 'UNREVIEWED_OPERATION' });
  assert.deepEqual(seen, ['/start?q=alpha']);
});
