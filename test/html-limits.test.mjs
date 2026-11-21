import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { extractHtml } from '../src/artifact/html.mjs';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';

const spec = { mode: 'list', root: 'li', fields: { name: {} } };
const page = (q, n) => Array.from({ length: n }, (_, i) => `<li>${q} item ${i}</li>`).join('');

test('HTML lists of 329 items are complete through the recipe runner', async t => {
  const server = createServer((request, response) => {
    const query = new URL(request.url, 'http://localhost').searchParams.get('q');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page(query, 329));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const traces = ['alpha', 'beta'].map(q => ({ input: { q }, calls: [{ origin, path: '/list', method: 'GET', encoding: 'query', params: { q }, status: 200,
    response_kind: 'html', response: extractHtml(page(q, 329), `${origin}/list`, spec) }] }));
  const approved = [{ origin, path: '/list', method: 'GET', success: {} }];
  const recipe = compileRecipe({ id: 'read_list', traces, approvedRequests: approved, extract: spec });
  const result = await createRecipeRunner(recipe, approved, { allowLoopback: true })({ q: 'gamma' });
  assert.equal(result.data.items.length, 329);
  assert.equal(result.data.items[328].name, 'gamma item 328');
});

test('HTML lists exceeding the extraction limit fail instead of truncating', () => {
  assert.throws(() => extractHtml(page('alpha', 1001), 'https://example.com/', spec), { code: 'EXTRACTION_LIMIT_EXCEEDED' });
});

test('an object extraction refuses ambiguous roots instead of choosing the first', () => {
  const object = { mode: 'object', root: 'article', fields: { title: { selector: 'h1' } } };
  const html = '<article><h1>First</h1></article><article><h1>Second</h1></article>';
  assert.throws(() => extractHtml(html, 'https://example.com/', object), { code: 'AMBIGUOUS_EXTRACTION' });
});
