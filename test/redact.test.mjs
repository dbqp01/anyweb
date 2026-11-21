import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactUrl } from '../src/redact.mjs';

// Deliberately fake values: these tests must never contain real credentials.
const FAKE = 'DEMO-ONLY-NOT-A-REAL-SECRET';
const REDACTED = '[REDACTED]';

test('redact hides api keys, jwt, auth, session and csrf under common spellings', () => {
  const input = {
    api_key: FAKE, apiKey: FAKE, 'api-key': FAKE, apikey: FAKE, 'x-api-key': FAKE,
    jwt: FAKE, auth: FAKE, Authorization: `Bearer ${FAKE}`, session: FAKE, sessionId: FAKE,
    csrf: FAKE, csrf_token: FAKE, XSRF: FAKE, Cookie: `sid=${FAKE}`,
  };
  const output = redact(input);
  for (const key of Object.keys(input)) assert.equal(output[key], REDACTED, `key ${key}`);
  assert.equal(JSON.stringify(output).includes(FAKE), false);
});

test('redact preserves benign keys that merely resemble secret names', () => {
  const input = { author: 'Ada', authority: 'public', keyboard: 'us', key: 'public-id', monkey: 'animal', api: 'v2' };
  assert.deepEqual(redact(input), input);
});

test('redact walks nested objects and arrays without mutating the source', () => {
  const input = {
    keep: 'visible',
    data: { items: [{ id: 1, apiKey: FAKE }, { id: 2, nested: { csrfToken: FAKE, ok: true } }] },
  };
  const snapshot = structuredClone(input);
  const output = redact(input);
  assert.deepEqual(input, snapshot);
  assert.equal(output.keep, 'visible');
  assert.equal(output.data.items[0].id, 1);
  assert.equal(output.data.items[0].apiKey, REDACTED);
  assert.equal(output.data.items[1].nested.csrfToken, REDACTED);
  assert.equal(output.data.items[1].nested.ok, true);
  assert.equal(JSON.stringify(output).includes(FAKE), false);
});

test('redact survives circular references', () => {
  const node = { id: 'n1', apiKey: FAKE };
  node.self = node;
  const output = redact(node);
  assert.equal(output.apiKey, REDACTED);
  assert.equal(output.self, '[Circular]');
  assert.doesNotThrow(() => JSON.stringify(output));
});

test('redact only marks true cycles, not shared references', () => {
  const shared = { id: 'shared', value: 'ok' };
  const output = redact({ first: shared, second: shared });
  assert.deepEqual(output.first, { id: 'shared', value: 'ok' });
  assert.deepEqual(output.second, { id: 'shared', value: 'ok' });
});

test('redact bounds recursion so a very deep payload cannot overflow the stack', () => {
  let input = { apiKey: FAKE };
  for (let i = 0; i < 500; i += 1) input = { child: input };
  let output;
  assert.doesNotThrow(() => { output = redact(input); });
  assert.equal(JSON.stringify(output).includes(FAKE), false);
});

test('redactUrl hides api keys, jwt, auth, session and csrf in the query', () => {
  const url = 'https://shop.example.com/search?q=shoes&api_key=FAKE1&apiKey=FAKE2&x-api-key=FAKE3&jwt=FAKE4&auth=FAKE5&session=FAKE6&csrf_token=FAKE7&API_KEY=FAKE8';
  const output = redactUrl(url);
  for (const value of ['FAKE1', 'FAKE2', 'FAKE3', 'FAKE4', 'FAKE5', 'FAKE6', 'FAKE7', 'FAKE8']) {
    assert.equal(output.includes(value), false, `leaked ${value}`);
  }
  const params = new URL(output).searchParams;
  assert.equal(params.get('q'), 'shoes');
  for (const key of ['api_key', 'apiKey', 'x-api-key', 'jwt', 'auth', 'session', 'csrf_token', 'API_KEY']) {
    assert.equal(params.get(key), REDACTED, `key ${key}`);
  }
});

test('redactUrl preserves the public token flags', () => {
  const keep = 'https://cdn.example.com/tweet-result?id=21&token=0';
  assert.equal(redactUrl(keep), keep);
  assert.equal(new URL(redactUrl('https://example.com/e?token=12')).searchParams.get('token'), '12');
  assert.equal(new URL(redactUrl('https://example.com/e?token=123')).searchParams.get('token'), REDACTED);
  assert.equal(new URL(redactUrl('https://example.com/e?access_token=0')).searchParams.get('access_token'), REDACTED);
  // A public-looking sibling must not hide a secret under the same key.
  assert.equal(redactUrl('https://example.com/e?token=0&token=FAKE9').includes('FAKE9'), false);
});

test('redactUrl hides credentials embedded in the URL and in OAuth fragments', () => {
  const userinfo = redactUrl('https://demo-user:FAKE10@example.com/private');
  assert.equal(userinfo.includes('FAKE10'), false);
  assert.equal(userinfo.includes('demo-user'), false);
  assert.equal(new URL(userinfo).host, 'example.com');
  const fragment = redactUrl('https://app.example.com/callback#access_token=FAKE11&token_type=bearer&state=ok');
  assert.equal(fragment.includes('FAKE11'), false);
  assert.match(fragment, /state=ok/);
});

test('redactUrl scrubs query strings it cannot parse as absolute URLs', () => {
  const relative = redactUrl('/search?api_key=FAKE12&q=shoes');
  assert.equal(relative.includes('FAKE12'), false);
  assert.match(relative, /^\/search\?/);
  assert.match(relative, /q=shoes/);
  assert.equal(redactUrl(null), null);
});

test('redaction is idempotent', () => {
  const once = redact({ nested: { apiKey: FAKE }, list: [{ csrf: FAKE }] });
  assert.deepEqual(redact(once), once);
  const url = redactUrl('https://example.com/x?api_key=FAKE&token=0');
  assert.equal(redactUrl(url), url);
});
