import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { compileBrowserRecipe, browserRecipeSchema } from '../src/artifact/browser.mjs';
import { createBrowserRunner } from '../src/browser/runner.mjs';
import { proposeBrowser } from '../src/commands/propose-browser.mjs';

const extract = { mode: 'object', root: '#note', fields: {
  id: { attr: 'data-id' },
  title: { selector: 'h1' },
  body: { selector: '#body' },
} };
const session = {
  cookies: [{ name: 'sid', value: 'reader', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [],
};
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Note</title></head><body>
<article id="note"><h1>Loading…</h1><p id="body"></p></article>
<script>
const id = new URLSearchParams(location.search).get('id') ?? '';
fetch('/api/note?id=' + encodeURIComponent(id)).then(response => {
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}).then(note => {
  document.querySelector('h1').textContent = note.title;
  document.querySelector('#body').textContent = note.body;
  document.querySelector('#note').dataset.id = note.id;
}).catch(error => { document.querySelector('h1').textContent = 'Error'; });
</script></body></html>`;

const demonstration = (origin, id, role = 'train') => ({
  role, input: { note_id: id },
  requests: [
    { method: 'GET', url: `${origin}/notes?id=${encodeURIComponent(id)}`, status: 200 },
    { method: 'GET', url: `${origin}/api/note?id=${encodeURIComponent(id)}`, status: 200 },
  ],
  browser_actions: [{ action: 'open', url: `${origin}/notes?id=${encodeURIComponent(id)}` }],
  browser_output: { id, title: `Note ${id}`, body: `Body for ${id}` },
});

async function startNotesFixture() {
  const requests = [], redirected = [];
  const evil = createServer((request, response) => { redirected.push(request.url); response.writeHead(200); response.end('collected'); });
  await new Promise(resolve => evil.listen(0, '127.0.0.1', resolve));
  const evilOrigin = `http://127.0.0.1:${evil.address().port}`;
  const authorized = request => (request.headers.cookie ?? '').split(';').map(part => part.trim()).includes('sid=reader');
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const authenticated = authorized(request);
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), authenticated });
    if (!['/notes', '/api/note'].includes(url.pathname)) { response.writeHead(404); return response.end(); }
    if (!authenticated) { response.writeHead(401); return response.end('sign in'); }
    const id = url.searchParams.get('id') ?? '';
    if (url.pathname === '/api/note') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ id, title: `Note ${id}`, body: `Body for ${id}` }));
    }
    if (id === 'redirect') { response.writeHead(302, { location: `${evilOrigin}/collect` }); return response.end(); }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests, redirected,
    close: async () => Promise.all([
      new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
      new Promise(resolve => { evil.close(resolve); evil.closeAllConnections(); }),
    ]),
  };
}

test('browser compiler binds a demonstrated query value to its input without persisting examples', () => {
  const origin = 'https://notes.example';
  const recipe = compileBrowserRecipe({ id: 'note_detail', input_fields: ['note_id'], session: 'reader', extract,
    marks: [demonstration(origin, 'n1'), demonstration(origin, 'n2')] });
  assert.deepEqual(recipe.steps, [{ action: 'open', url: `${origin}/notes`,
    query: [{ name: 'id', kind: 'input', field: 'note_id' }] }]);
  assert.equal(JSON.stringify(recipe).includes('"n1"'), false);
  assert.equal(JSON.stringify(recipe).includes('"n2"'), false);
  assert.equal(JSON.stringify(recipe).includes('?id='), false);
  assert.equal(browserRecipeSchema.safeParse(recipe).success, true);

  const mixed = [demonstration(origin, 'n1'), demonstration(origin, 'n2')];
  mixed[0].browser_actions[0].url = `${origin}/notes?view=full&id=n1`;
  mixed[1].browser_actions[0].url = `${origin}/notes?view=full&id=n2`;
  assert.equal(compileBrowserRecipe({ id: 'note_detail', input_fields: ['note_id'], extract, marks: mixed }).steps[0].url,
    `${origin}/notes?view=full`);

  const legacy = { ...recipe, steps: [{ action: 'open', url: `${origin}/notes?id=n1` }] };
  assert.equal(browserRecipeSchema.safeParse(legacy).success, true);
  assert.equal(browserRecipeSchema.safeParse({ ...recipe, steps: [{ action: 'open', url: `${origin}/notes`,
    query: [{ name: 'access_token', kind: 'input', field: 'note_id' }] }] }).success, false);
  assert.equal(browserRecipeSchema.safeParse({ ...recipe, steps: [{ action: 'open', url: `${origin}/notes?id=x`,
    query: [{ name: 'id', kind: 'input', field: 'note_id' }] }] }).success, false);
  assert.equal(browserRecipeSchema.safeParse({ ...recipe, steps: [{ action: 'open', url: `${origin}/notes`,
    query: [{ name: 'id', kind: 'input', field: 'unknown' }] }] }).success, false);
});

test('browser compiler refuses origin changes, shape changes, secret keys and unbound query values', () => {
  const origin = 'https://notes.example', other = 'https://other.example';
  const compile = marks => () => compileBrowserRecipe({ id: 'note_detail', input_fields: ['note_id'], extract, marks });
  assert.throws(compile([demonstration(origin, 'n1'), demonstration(other, 'n2')]), { code: 'INCONSISTENT_BROWSER_ACTIONS' });
  assert.throws(compile([demonstration(origin, 'n1'), { ...demonstration(origin, 'n2'), browser_actions: [{ action: 'open', url: `${origin}/notes` }] }]),
    { code: 'INCONSISTENT_BROWSER_ACTIONS' });
  assert.throws(compile([demonstration(origin, 'n1'), { ...demonstration(origin, 'n2'), input: { note_id: 'other' } }]),
    { code: 'UNBOUND_BROWSER_VALUE' });
  const secret = [demonstration(origin, 'n1'), demonstration(origin, 'n2')];
  secret[0].browser_actions[0].url = `${origin}/notes?access_token=n1`;
  secret[1].browser_actions[0].url = `${origin}/notes?access_token=n2`;
  assert.throws(compile(secret), { code: 'SECRET_IN_RECIPE' });
  const ambiguous = [demonstration(origin, 'n1'), demonstration(origin, 'n2')];
  for (const mark of ambiguous) mark.input.alias = mark.input.note_id;
  assert.throws(() => compileBrowserRecipe({ id: 'note_detail', input_fields: ['note_id', 'alias'], extract, marks: ambiguous }),
    { code: 'UNBOUND_BROWSER_VALUE' });
});

test('browser proposal reads unseen authenticated records by query id and fails safely', { timeout: 120000 }, async t => {
  const fixture = await startNotesFixture();
  t.after(() => fixture.close());
  const marks = [demonstration(fixture.origin, 'n1'), demonstration(fixture.origin, 'n2'), demonstration(fixture.origin, 'n3', 'eval')];
  const { recipe, approved } = await proposeBrowser({ id: 'note_detail', input_fields: ['note_id'], extract }, marks,
    { origin: fixture.origin, allowed_origins: [], session: 'reader' }, session);
  assert.deepEqual(recipe.steps, [{ action: 'open', url: `${fixture.origin}/notes`,
    query: [{ name: 'id', kind: 'input', field: 'note_id' }] }]);
  assert.equal(JSON.stringify(recipe).includes('"n1"'), false);
  assert.equal(JSON.stringify(recipe).includes('"n3"'), false);
  assert.deepEqual(fixture.requests.filter(request => request.path === '/notes' && request.authenticated).map(request => request.query.id),
    ['n1', 'n2', 'n3']);

  const run = createBrowserRunner(recipe, approved, { session, allowLoopback: true });
  const injected = await run({ note_id: 'a&admin=1' });
  assert.deepEqual(injected.data, { id: 'a&admin=1', title: 'Note a&admin=1', body: 'Body for a&admin=1' });
  const navigation = fixture.requests.filter(request => request.path === '/notes').at(-1);
  assert.deepEqual(navigation.query, { id: 'a&admin=1' });
  assert.deepEqual(fixture.requests.filter(request => request.path === '/api/note').at(-1).query, { id: 'a&admin=1' });

  await assert.rejects(run({ note_id: 'redirect' }), { code: 'BROWSER_REDIRECT_UNSUPPORTED' });
  assert.deepEqual(fixture.redirected, []);

  const anonymous = createBrowserRunner(recipe, approved, { session: { cookies: [], origins: [] }, allowLoopback: true });
  await assert.rejects(anonymous({ note_id: 'n3' }), { code: 'REAUTH_REQUIRED' });

  // A recipe that pins a demonstrated value in its URL is no longer reviewed: the policy binds `id` to the input.
  const legacy = { ...recipe, steps: [{ action: 'open', url: `${fixture.origin}/notes?id=n1` }] };
  assert.throws(() => createBrowserRunner(legacy, approved, { session, allowLoopback: true }), { code: 'UNREVIEWED_QUERY' });
});
