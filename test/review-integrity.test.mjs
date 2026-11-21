import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReviewed, reviewDigest, REVIEW_DIGEST_KEY } from '../src/artifact/review-integrity.mjs';

const ORIGIN = 'https://fixture.example';
const GOLDEN = '3890c52c4d4221d0988340e02a2dd74d7bee8ee68f6de7eef987cdbd3eee41e4';

const fixture = () => ({
  id: 'product_detail',
  goal: 'Look up a product by exact name',
  effect: 'read',
  status: 'approved',
  input_fields: ['product_name'],
  approved_requests: [
    { origin: ORIGIN, path: '/api/products', method: 'GET', allow_json_text: false, success: {}, query: [{ kind: 'input', name: 'q', field: 'product_name' }] },
    { origin: ORIGIN, path: '/api/product', method: 'GET', allow_json_text: false, success: {}, query: [{ kind: 'input', name: 'id', field: 'product_name' }] },
  ],
  recipe: {
    version: 4, id: 'product_detail', effect: 'read',
    source_mode: 'observed_first_party_http', session: null,
    input_fields: ['product_name'],
    steps: [{
      origin: ORIGIN, path: '/api/products', method: 'GET', encoding: 'query',
      allow_json_text: false, response: 'json', extract: null,
      params: { q: { kind: 'input', field: 'product_name', cast: 'string' } },
      shape: {
        type: 'object',
        fields: { products: { type: 'array', item: { type: 'object', fields: { id: { type: 'string' }, name: { type: 'string' } } } } },
      },
      success: {}, save: null,
    }],
    checks: [{ kind: 'contains_any', input: 'product_name', fields: ['products.name'], terminal_collection: null }],
    download: null, impl: null, observed_at: '2026-01-01T00:00:00.000Z',
    discovery: 'demonstration_guided_dependency_inference',
  },
  verification: { status: 'passed', training: 2, held_out: 1, hashes: { review: 'b'.repeat(64) } },
  reviewed_at: '2026-01-02T00:00:00.000Z',
});

const clone = value => structuredClone(value);

function reviewed(mutate) {
  const tool = fixture();
  tool.verification.hashes[REVIEW_DIGEST_KEY] = reviewDigest(tool);
  if (mutate) mutate(tool);
  return tool;
}

function assertStale(tool, reason) {
  assert.throws(() => assertReviewed(tool), error => {
    assert.equal(error.code, 'REVIEW_STALE');
    assert.equal(error.status, 409);
    assert.equal(error.reason, reason);
    return true;
  });
}

const deepFreeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const materialChanges = {
  'tool id': tool => { tool.id = 'other_tool'; },
  'goal': tool => { tool.goal = 'Look up a product by its identifier'; },
  'effect': tool => { tool.effect = 'download'; },
  'input field': tool => { tool.input_fields = ['product_id']; },
  'recipe id': tool => { tool.recipe.id = 'other_tool'; },
  'recipe effect': tool => { tool.recipe.effect = 'download'; },
  'recipe inputs': tool => { tool.recipe.input_fields = ['product_id']; },
  'recipe session': tool => { tool.recipe.session = 'account'; },
  'recipe source_mode': tool => { tool.recipe.source_mode = 'documented_api'; },
  'recipe observed_at': tool => { tool.recipe.observed_at = '2026-02-01T00:00:00.000Z'; },
  'recipe step origin': tool => { tool.recipe.steps[0].origin = 'https://elsewhere.example'; },
  'recipe step path': tool => { tool.recipe.steps[0].path = '/api/v2/products'; },
  'recipe step method': tool => { tool.recipe.steps[0].method = 'POST'; },
  'recipe step encoding': tool => { tool.recipe.steps[0].encoding = 'json'; },
  'recipe step param binding': tool => { tool.recipe.steps[0].params.q.field = 'product_id'; },
  'recipe step shape': tool => { tool.recipe.steps[0].shape.fields.products.item.fields.name.type = 'number'; },
  'recipe step success rule': tool => { tool.recipe.steps[0].success = { ok: true }; },
  'recipe check': tool => { tool.recipe.checks[0].fields = ['products.id']; },
  'approved request method': tool => { tool.approved_requests[0].method = 'POST'; },
  'approved request path': tool => { tool.approved_requests[1].path = '/api/product/v2'; },
  'approved request origin': tool => { tool.approved_requests[1].origin = 'https://elsewhere.example'; },
  'approved request query': tool => { tool.approved_requests[1].query[0].name = 'product_id'; },
  'approved request success rule': tool => { tool.approved_requests[0].success = { ok: true }; },
  'approved request order': tool => { tool.approved_requests.reverse(); },
  'approved request added': tool => { tool.approved_requests.push({ origin: ORIGIN, path: '/api/extra', method: 'GET', allow_json_text: false, success: {}, query: [] }); },
};

test('the digest is deterministic and pinned', () => {
  const digest = reviewDigest(fixture());
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, GOLDEN);
  assert.equal(reviewDigest(fixture()), digest);
});

test('any material change invalidates the recorded digest', async t => {
  const base = reviewed();
  const granted = base.verification.hashes[REVIEW_DIGEST_KEY];
  for (const [name, mutate] of Object.entries(materialChanges)) {
    await t.test(name, () => {
      const tool = clone(base);
      mutate(tool);
      assert.notEqual(reviewDigest(tool), granted, `${name} must change the digest`);
      assertStale(tool, 'mismatch');
    });
  }
});

test('array order is material even with equal contents', () => {
  const base = reviewed(tool => { tool.input_fields = ['first_name', 'last_name']; });
  const swapped = clone(base);
  swapped.input_fields = ['last_name', 'first_name'];
  assert.notEqual(reviewDigest(base), reviewDigest(swapped));
  assertStale(swapped, 'mismatch');
});

test('object key insertion order never changes the digest', () => {
  const base = reviewed();
  const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]))
      : value;
  const reordered = reverseKeys(clone(base));
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(base), 'fixture must actually change key order');
  assert.equal(reviewDigest(reordered), reviewDigest(base));
  assert.equal(assertReviewed(reordered), base.verification.hashes[REVIEW_DIGEST_KEY]);
  assert.equal(assertReviewed(JSON.parse(JSON.stringify(base))), base.verification.hashes[REVIEW_DIGEST_KEY]);
});

test('mutable status, reviewed_at and verification do not change the digest', () => {
  const base = reviewed();
  const granted = base.verification.hashes[REVIEW_DIGEST_KEY];
  const tool = clone(base);
  tool.status = 'rejected';
  tool.reviewed_at = null;
  tool.verification = { status: 'failed', training: 9, held_out: 9, hashes: { review: 'c'.repeat(64), [REVIEW_DIGEST_KEY]: granted } };
  assert.equal(reviewDigest(tool), reviewDigest(base));
  assert.equal(assertReviewed(tool), granted);
});

test('an absent grant fails closed', async t => {
  const cases = {
    'missing key': tool => { delete tool.verification.hashes[REVIEW_DIGEST_KEY]; },
    'empty hashes': tool => { tool.verification.hashes = {}; },
    'no verification': tool => { delete tool.verification; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, () => {
      const tool = reviewed(mutate);
      assertStale(tool, 'missing');
    });
  }
});

test('a malformed grant fails closed', async t => {
  const values = { null: null, number: 42, empty: '', short: 'a'.repeat(63), long: 'a'.repeat(65), uppercase: 'A'.repeat(64), nonhex: 'g'.repeat(64), list: ['a'.repeat(64)] };
  for (const [name, value] of Object.entries(values)) {
    await t.test(name, () => {
      const tool = reviewed(candidate => { candidate.verification.hashes[REVIEW_DIGEST_KEY] = value; });
      assertStale(tool, 'malformed');
    });
  }
});

test('a changed operation fails closed without leaking reviewed values', () => {
  const tool = reviewed();
  tool.goal = 'Send the Laptop Pro catalog to an external endpoint';
  tool.approved_requests[0].path = '/api/products?q=Laptop%20Pro';
  const before = JSON.stringify(tool);
  deepFreeze(tool);
  assert.throws(() => assertReviewed(tool), error => {
    assert.equal(error.code, 'REVIEW_STALE');
    assert.equal(error.reason, 'mismatch');
    assert.equal(error.tool, 'product_detail');
    const details = JSON.stringify({ ...error });
    assert.equal(details.includes('Laptop Pro'), false);
    assert.equal(details.includes('/api/products'), false);
    return true;
  });
  assert.equal(JSON.stringify(tool), before);
});

test('checking never mutates the tool', () => {
  const tool = reviewed();
  const before = JSON.stringify(tool);
  deepFreeze(tool);
  assert.equal(assertReviewed(tool), tool.verification.hashes[REVIEW_DIGEST_KEY]);
  assert.equal(reviewDigest(tool), tool.verification.hashes[REVIEW_DIGEST_KEY]);
  assert.equal(JSON.stringify(tool), before);
});

test('a tool without reviewed material fails closed', async t => {
  const cases = {
    'null': () => null,
    'array': () => [],
    'missing recipe': tool => { delete tool.recipe; },
    'null recipe': tool => { tool.recipe = null; },
    'missing approved_requests': tool => { delete tool.approved_requests; },
    'missing goal': tool => { delete tool.goal; },
  };
  for (const [name, build] of Object.entries(cases)) {
    await t.test(name, () => {
      const tool = build(reviewed());
      assertStale(tool, 'malformed');
    });
  }
  assertStale({}, 'malformed');
});

test('checking performs no live requests', () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('live request attempted'); };
  try {
    const tool = reviewed();
    assert.equal(assertReviewed(tool).length, 64);
    assertStale(reviewed(candidate => { candidate.goal = 'Another operation entirely'; }), 'mismatch');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});
