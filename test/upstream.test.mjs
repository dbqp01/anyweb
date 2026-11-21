import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { upstreamHtml, upstreamJson, upstreamBinary } from '../src/net/upstream.mjs';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTML runner scopes saved cookies at every redirect and resolves final-page links', async t => {
  const seen = [];
  const origin = await fixture(t, (request, response) => {
    seen.push({ path: request.url, cookie: request.headers.cookie });
    if (request.url.startsWith('/private/search')) {
      response.writeHead(302, { location: '/public/results/' });
      return response.end('Redirecting');
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<li><span>alpha</span><a href="detail">Open</a></li>');
  });
  const approved = [{ origin, path: '/private/search', method: 'GET', success: {} }, { origin, path: '/public/results/', method: 'GET', success: {} }];
  const traces = ['alpha', 'beta'].map(q => ({ input: { q }, calls: [{
    origin, path: '/private/search', method: 'GET', encoding: 'query', params: { q }, status: 200, response_kind: 'html',
    response: { items: [{ name: q, url: `${origin}/public/results/detail` }] },
  }] }));
  const recipe = compileRecipe({ id: 'search_items', traces, approvedRequests: approved,
    extract: { mode: 'list', root: 'li', fields: { name: { selector: 'span' }, url: { selector: 'a', attr: 'href', absolute: true } } } });
  const cookie = (name, path, extra = {}) => ({ name, value: 'v', domain: '127.0.0.1', path, expires: -1, secure: false, ...extra });
  const session = { cookies: [cookie('root', '/'), cookie('private', '/private'), cookie('public', '/public'),
    cookie('secure', '/', { secure: true }), cookie('expired', '/', { expires: 1 }), cookie('nearby', '/public/result')] };
  const result = await createRecipeRunner(recipe, approved, { session, allowLoopback: true })({ q: 'alpha' });
  assert.deepEqual(seen, [
    { path: '/private/search?q=alpha', cookie: 'private=v; root=v' },
    { path: '/public/results/', cookie: 'public=v; root=v' },
  ]);
  assert.equal(result.data.items[0].url, `${origin}/public/results/detail`);
});

test('HTML redirect methods follow HTTP semantics without mutating request options', async t => {
  for (const status of [301, 302, 303, 307, 308]) await t.test(String(status), async t => {
    const seen = [];
    const origin = await fixture(t, async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      seen.push({ method: request.method, body: Buffer.concat(chunks).toString(), type: request.headers['content-type'] });
      if (request.url === '/start') {
        response.writeHead(status, { location: '/finish' });
        return response.end('Redirecting');
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<p>Done</p>');
    });
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '2' }, body: '{}' };
    const before = structuredClone(init);
    const result = await upstreamHtml(`${origin}/start`, init);
    const preserved = status === 307 || status === 308;
    assert.equal(result.url, `${origin}/finish`);
    assert.deepEqual(seen[1], { method: preserved ? 'POST' : 'GET', body: preserved ? '{}' : '', type: preserved ? 'application/json' : undefined });
    assert.deepEqual(init, before);
  });
});

test('HTML refuses redirects to another origin, embedded credentials, and redirect loops', async t => {
  for (const target of ['other-origin', 'credentials', 'loop']) await t.test(target, async t => {
    let received = 0;
    const origin = await fixture(t, (request, response) => {
      received++;
      const location = target === 'loop' ? '/start' : target === 'credentials'
        ? origin.replace('://', '://user:password@') + '/next'
        : origin.replace('127.0.0.1', 'localhost') + '/next';
      response.writeHead(302, { location });
      response.end('Redirecting');
    });
    await assert.rejects(upstreamHtml(`${origin}/start`, { headers: { Authorization: 'test-only' } }), { code: 'UPSTREAM_UNAVAILABLE' });
    assert.equal(received, target === 'loop' ? 4 : 1);
  });
});

test('JSON and downloads continue to reject redirects', async t => {
  let received = 0;
  const origin = await fixture(t, (request, response) => {
    received++;
    response.writeHead(302, { location: '/next' });
    response.end('Redirecting');
  });
  await assert.rejects(upstreamJson(`${origin}/start`), { code: 'UPSTREAM_UNAVAILABLE' });
  await assert.rejects(upstreamBinary(`${origin}/start`), { code: 'UPSTREAM_UNAVAILABLE' });
  assert.equal(received, 2);
});

test('transport cancels unread bodies on redirects, HTTP errors and oversized responses', async t => {
  for (const [status, headers, code] of [
    [302, { location: 'https://other.example/next' }, 'UPSTREAM_UNAVAILABLE'],
    [429, {}, 'RATE_LIMITED'],
    [200, { 'content-length': '9000000' }, 'UPSTREAM_TOO_LARGE'],
  ]) await t.test(String(status), async t => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    t.mock.method(globalThis, 'fetch', async () => new Response(body, { status, headers }));
    await assert.rejects(upstreamHtml('https://example.com/start'), { code });
    assert.equal(cancelled, true);
  });
});

test('redirects share one timeout budget and cancel each skipped body', async t => {
  let requests = 0, cancelled = 0, signals = [];
  const controller = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => controller.signal);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests++;
    signals.push(init.signal);
    if (requests === 2) {
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      init.signal.throwIfAborted();
    }
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 302, headers: { location: '/next' } });
  });
  await assert.rejects(upstreamHtml('https://example.com/start'), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(timeout.mock.callCount(), 1);
  assert.equal(signals[0], signals[1]);
  assert.equal(cancelled, 1);
});
