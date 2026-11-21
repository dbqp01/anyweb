import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createBrowserRunner } from '../src/browser/runner.mjs';
import { proposeBrowser } from '../src/commands/propose-browser.mjs';
import { readPolicySchema } from '../src/artifact/recipe.mjs';

const extract = { mode: 'object', root: '#note', fields: {
  id: { attr: 'data-id' },
  title: { selector: 'h1' },
  body: { selector: '#body' },
} };

// The page issues a second, page-chosen request: /api/item?action=read normally,
// ?action=delete when the record says so. Pathname-only approval would allow both.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Note</title></head><body>
<article id="note"><h1>Loading…</h1><p id="body"></p></article>
<script>
const note = new URLSearchParams(location.search).get('note') ?? '';
const extra = note === 'inject' ? '&admin=1' : '';
fetch('/api/note?note=' + encodeURIComponent(note) + extra).then(response => {
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}).then(async data => {
  await fetch('/api/item?action=' + encodeURIComponent(data.action)).catch(() => {});
  document.querySelector('#note').dataset.id = data.id;
  document.querySelector('h1').textContent = data.title;
  document.querySelector('#body').textContent = data.body;
}).catch(() => { document.querySelector('h1').textContent = 'Error'; });
</script></body></html>`;

async function startQueryFixture() {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (url.pathname === '/notes') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end(PAGE);
    }
    if (url.pathname === '/static') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return response.end('<!doctype html><html><body><article id="note" data-id="n1"><h1>Note n1</h1><p id="body">Body for n1</p></article></body></html>');
    }
    if (url.pathname === '/api/note') {
      const note = url.searchParams.get('note') ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ id: note, title: `Note ${note}`, body: `Body for ${note}`,
        action: note === 'wipe' ? 'delete' : 'read' }));
    }
    if (url.pathname === '/api/item') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ action: url.searchParams.get('action') }));
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
  };
}

const demonstration = (origin, note, role = 'train', extra = []) => ({
  role, input: { note_id: note },
  requests: [
    { method: 'GET', url: `${origin}/notes?note=${encodeURIComponent(note)}`, status: 200 },
    { method: 'GET', url: `${origin}/api/note?note=${encodeURIComponent(note)}`, status: 200 },
    { method: 'GET', url: `${origin}/api/item?action=read`, status: 200 },
    ...extra,
  ],
  browser_actions: [{ action: 'open', url: `${origin}/notes?note=${encodeURIComponent(note)}` }],
  browser_output: { id: note, title: `Note ${note}`, body: `Body for ${note}` },
});

test('approved read policies carry an exact query policy and reject unsafe rules', () => {
  const base = { origin: 'https://notes.example', path: '/notes', method: 'GET' };
  assert.deepEqual(readPolicySchema.parse(base).query, []);
  assert.deepEqual(readPolicySchema.parse({ ...base, query: [{ kind: 'literal', name: 'action', value: 'read' }] }).query,
    [{ kind: 'literal', name: 'action', value: 'read' }]);
  assert.equal(readPolicySchema.safeParse({ ...base, query: [{ kind: 'input', name: 'access_token', field: 'note_id' }] }).success, false);
  assert.equal(readPolicySchema.safeParse({ ...base, query: [
    { kind: 'input', name: 'note', field: 'note_id' }, { kind: 'literal', name: 'note', value: 'n1' }] }).success, false);
  assert.equal(readPolicySchema.safeParse({ ...base, query: [{ kind: 'input', name: 'note', field: 'note_id' }], extra: 1 }).success, false);
});

test('browser proposal bounds query keys to training observations and blocks drift before the request', { timeout: 120000 }, async t => {
  const fixture = await startQueryFixture();
  t.after(() => fixture.close());
  const marks = [demonstration(fixture.origin, 'n1'), demonstration(fixture.origin, 'n2'),
    demonstration(fixture.origin, 'n3', 'eval', [{ method: 'GET', url: `${fixture.origin}/api/item?action=read&admin=1`, status: 200 }])];
  const { recipe, approved } = await proposeBrowser({ id: 'note_detail', input_fields: ['note_id'], extract }, marks,
    { origin: fixture.origin, allowed_origins: [], session: null }, null);

  const policy = path => approved.find(request => request.path === path).query;
  assert.deepEqual(policy('/notes'), [{ name: 'note', kind: 'input', field: 'note_id' }]);
  assert.deepEqual(policy('/api/note'), [{ name: 'note', kind: 'input', field: 'note_id' }]);
  assert.deepEqual(policy('/api/item'), [{ name: 'action', kind: 'literal', value: 'read' }]);
  // Eval marks are executed under the training policy; they never widen it.
  assert.equal(JSON.stringify(approved).includes('admin'), false);
  assert.equal(JSON.stringify(recipe).includes('"n1"'), false);
  assert.equal(JSON.stringify(recipe).includes('"n3"'), false);

  const run = createBrowserRunner(recipe, approved, { allowLoopback: true });
  const injected = await run({ note_id: 'a&admin=1' });
  assert.deepEqual(injected.data, { id: 'a&admin=1', title: 'Note a&admin=1', body: 'Body for a&admin=1' });
  assert.deepEqual(fixture.requests.filter(request => request.path === '/notes').at(-1).query, { note: 'a&admin=1' });
  assert.deepEqual(fixture.requests.filter(request => request.path === '/api/note').at(-1).query, { note: 'a&admin=1' });

  // A page-issued parameter outside the policy is aborted before it reaches upstream.
  await assert.rejects(run({ note_id: 'inject' }), { code: 'UNREVIEWED_QUERY' });
  assert.deepEqual(fixture.requests.filter(request => request.path === '/api/note').at(-1).query, { note: 'a&admin=1' });
  assert.equal(fixture.requests.some(request => Object.hasOwn(request.query, 'admin')), false);

  // An approved read endpoint cannot be turned into a write by the page.
  await assert.rejects(run({ note_id: 'wipe' }), { code: 'UNREVIEWED_QUERY' });
  assert.deepEqual([...new Set(fixture.requests.filter(request => request.path === '/api/item').map(request => request.query.action))], ['read']);
});

test('recipes cannot add or rebind static query values the policy did not review', { timeout: 120000 }, async t => {
  const fixture = await startQueryFixture();
  t.after(() => fixture.close());
  const marks = [demonstration(fixture.origin, 'n1'), demonstration(fixture.origin, 'n2')];
  const { recipe, approved } = await proposeBrowser({ id: 'note_detail', input_fields: ['note_id'], extract }, marks,
    { origin: fixture.origin, allowed_origins: [], session: null }, null);
  const options = { allowLoopback: true };

  const before = fixture.requests.length;
  assert.throws(() => createBrowserRunner({ ...recipe, steps: [{ action: 'open', url: `${fixture.origin}/api/item?action=delete` }] }, approved, options),
    { code: 'UNREVIEWED_QUERY' });
  assert.throws(() => createBrowserRunner({ ...recipe, steps: [{ action: 'open', url: `${fixture.origin}/api/item`,
    query: [{ name: 'action', kind: 'input', field: 'note_id' }] }] }, approved, options), { code: 'UNREVIEWED_QUERY' });
  assert.throws(() => createBrowserRunner({ ...recipe, steps: [{ action: 'open', url: `${fixture.origin}/notes?note=n1&admin=1` }] }, approved, options),
    { code: 'UNREVIEWED_QUERY' });
  assert.equal(fixture.requests.length, before);

  // Legacy approvals have no query policy: fail closed on query-bearing requests, keep query-less reads working.
  const legacyApproved = approved.map(({ origin, path, method, success }) => ({ origin, path, method, success }));
  assert.throws(() => createBrowserRunner(recipe, legacyApproved, options), { code: 'UNREVIEWED_QUERY' });

  const staticRecipe = { version: 1, execution: 'browser', id: 'static_note', effect: 'read', input_fields: ['note_id'], session: null,
    steps: [{ action: 'open', url: `${fixture.origin}/static` }], extract, required_fields: ['id', 'title', 'body'],
    checks: [{ input: 'note_id', fields: ['title'] }], observed_at: new Date().toISOString(), discovery: 'demonstration_guided_browser_inference' };
  const result = await createBrowserRunner(staticRecipe, [{ origin: fixture.origin, path: '/static', method: 'GET' }], options)({ note_id: 'n1' });
  assert.deepEqual(result.data, { id: 'n1', title: 'Note n1', body: 'Body for n1' });
});
