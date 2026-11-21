import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';

const spec = { mode: 'object', root: 'article', fields: { name: { selector: 'h1' } } };

test('an expired session redirecting to login reports REAUTH_REQUIRED', async t => {
  const server = createServer((request, response) => {
    if (request.url.startsWith('/item')) { response.writeHead(302, { location: '/login/index.php' }); return response.end(); }
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<form><input type="password"></form>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const traces = ['alpha', 'beta'].map(q => ({ input: { q }, calls: [{ origin, path: '/item', method: 'GET', encoding: 'query',
    params: { q }, status: 200, response_kind: 'html', response: { name: q } }] }));
  const approved = [{ origin, path: '/item', method: 'GET', success: {} }];
  const recipe = compileRecipe({ id: 'read_item', traces, approvedRequests: approved, extract: spec, session: 'default' });
  await assert.rejects(createRecipeRunner(recipe, approved, { allowLoopback: true, session: { cookies: [] } })({ q: 'alpha' }), { code: 'REAUTH_REQUIRED' });
});
