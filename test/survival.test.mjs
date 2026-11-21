import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { upstreamHtml, upstreamJson } from '../src/net/upstream.mjs';
import { isChallenge } from '../src/net/challenge.mjs';
import { handoff } from '../src/mcp/server.mjs';
import { WorkflowError } from '../src/artifact/errors.mjs';
import { compileBrowserRecipe } from '../src/artifact/browser.mjs';
import { createBrowserRunner } from '../src/browser/runner.mjs';

async function serve(t, handler) {
  const hits = [];
  const server = createServer((request, response) => { hits.push(request.method); handler(request, response, hits.length); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}
const json = (response, status, body, headers = {}) => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };
const html = (response, status, body, headers = {}) => { response.writeHead(status, { 'content-type': 'text/html', ...headers }); response.end(body); };

test('reads survive transient 5xx and network resets', async t => {
  const site = await serve(t, (request, response, hit) => {
    if (hit === 1) return request.socket.destroy();
    if (hit === 2) return json(response, 503, {});
    json(response, 200, { ok: true });
  });
  assert.deepEqual(await upstreamJson(`${site.origin}/api`), { ok: true });
  assert.equal(site.hits.length, 3);
});

test('writes are never retried', async t => {
  const site = await serve(t, (request, response) => json(response, 503, {}));
  await assert.rejects(upstreamJson(`${site.origin}/api`, { method: 'POST', body: '{}' }), { code: 'UPSTREAM_UNAVAILABLE' });
  assert.equal(site.hits.length, 1);
});

test('a long Retry-After is reported instead of waited out', async t => {
  const site = await serve(t, (request, response) => json(response, 429, {}, { 'retry-after': '60' }));
  const error = await upstreamJson(`${site.origin}/api`).catch(error => error);
  assert.equal(error.code, 'RATE_LIMITED');
  assert.equal(site.hits.length, 1);
  assert.deepEqual(handoff(error, { origin: site.origin }, { recipe: { session: null } }), { retry_after_seconds: 60 });
});

test('headers larger than Node\'s 16 KB default are accepted', async t => {
  const site = await serve(t, (request, response) => json(response, 200, { ok: true }, { 'x-padding': 'a'.repeat(21000) }));
  assert.deepEqual(await upstreamJson(`${site.origin}/api`), { ok: true });
});

test('captchas and WAF pages stop with CHALLENGE_REQUIRED instead of a vague failure', async t => {
  const pages = {
    '/blocked': [403, '<html><div class="g-recaptcha" data-sitekey="x"></div></html>'],
    '/waf': [200, '<html><head><title>¡Alto, no puedes acceder!</title></head></html>'],
    '/cloudflare': [503, '<html><script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script></html>'],
  };
  const site = await serve(t, (request, response) => html(response, ...pages[request.url]));
  for (const path of Object.keys(pages)) {
    await assert.rejects(upstreamHtml(`${site.origin}${path}`), { code: 'CHALLENGE_REQUIRED', site: site.origin }, path);
  }
  assert.equal(site.hits.length, 3, 'a challenge is never retried');
});

test('ordinary pages with a login captcha or a plain 403 are not challenges', () => {
  assert.equal(isChallenge({ status: 200, html: '<form><div class="g-recaptcha"></div><input name=user></form>' }), false);
  assert.equal(isChallenge({ status: 403, html: '{"error":"forbidden"}' }), false);
  assert.equal(isChallenge({ status: 200, headers: new Headers({ 'cf-mitigated': 'challenge' }), html: '' }), true);
});

test('person-only failures carry the exact next step', () => {
  const site = { origin: 'https://shop.example' };
  const withSession = handoff(new WorkflowError('CHALLENGE_REQUIRED', 403), site, { recipe: { session: 'default' } });
  assert.equal(withSession.needs_person, true);
  assert.match(withSession.instruction, /anyweb session login --site https:\/\/shop\.example --session default/);
  assert.match(handoff(new WorkflowError('CHALLENGE_REQUIRED', 403), site, { recipe: { session: null } }).instruction, /do not retry/);
  assert.equal(handoff(new WorkflowError('REAUTH_REQUIRED', 401), site, { recipe: { session: 'work' } }).needs_person, true);
  assert.deepEqual(handoff(new WorkflowError('UPSTREAM_CHANGED'), site, { recipe: { session: null } }), {});
});

const browserTool = origin => {
  const mark = (name, id) => ({
    role: 'train', input: { product_name: name }, requests: [{ method: 'GET', url: `${origin}/browser`, status: 200 }],
    browser_actions: [{ action: 'open', url: `${origin}/browser` }, { action: 'click', locator: { kind: 'role', role: 'button', name } }],
    browser_output: { id, name },
  });
  const recipe = compileBrowserRecipe({ id: 'browser_detail', input_fields: ['product_name'],
    extract: { mode: 'object', root: '#d', fields: { id: { attr: 'data-id' }, name: { selector: 'h1' } } }, marks: [mark('Laptop Pro', 'p1'), mark('Laptop Air', 'p2')] });
  return createBrowserRunner(recipe, [{ origin, path: '/browser', method: 'GET', success: {} }], { allowLoopback: true });
};

test('the browser runner hands challenges to the person and retries a failing site once', { timeout: 60000 }, async t => {
  const blocked = await serve(t, (request, response) => html(response, 403, '<html><iframe src="https://hcaptcha.com/x"></iframe></html>'));
  await assert.rejects(browserTool(blocked.origin)({ product_name: 'Laptop Pro' }), { code: 'CHALLENGE_REQUIRED' });
  assert.equal(blocked.hits.length, 1);

  const down = await serve(t, (request, response) => html(response, 503, '<html>maintenance</html>'));
  await assert.rejects(browserTool(down.origin)({ product_name: 'Laptop Pro' }), { code: 'UPSTREAM_UNAVAILABLE' });
  assert.equal(down.hits.length, 2);
});
