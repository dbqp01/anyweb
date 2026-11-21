import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuard } from '../src/explore/guard.mjs';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';

test('a POST with an ordinary name cannot slip past exploration or self-approve', async () => {
  let handler, continued = false, aborted = false;
  const guard = createGuard({ route: (_pattern, callback) => { handler = callback; } });
  await handler({ request: () => ({ method: () => 'POST', url: () => 'https://example.com/api/cart', postData: () => '{"item":"one"}' }),
    continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
  assert.equal(continued, false);
  assert.equal(aborted, true);
  const [request] = guard.since(0);
  assert.throws(() => guard.confirm(request.nonce), { code: 'HUMAN_APPROVAL_UNAVAILABLE' });
});

test('an unproven POST recipe is never replayed or exposed as a read', () => {
  const origin = 'https://example.com';
  const approved = [{ origin, path: '/api/cart', method: 'POST', success: {} }];
  const traces = ['one', 'two'].map(item => ({ input: { item }, calls: [{ origin, path: '/api/cart', method: 'POST', encoding: 'json',
    params: { item }, status: 200, response: { item } }] }));
  const recipe = compileRecipe({ id: 'cart', traces, approvedRequests: approved });
  assert.throws(() => createRecipeRunner(recipe, approved), { code: 'UNSAFE_METHOD_UNSUPPORTED' });
});

test('GET search text does not trigger destructive-path detection, but action parameters do', async () => {
  for (const [url, allowed] of [
    ['https://example.com/search?q=buy', true],
    ['https://example.com/account?op=delete', false],
    ['https://example.com/account/close', false],
  ]) {
    let handler, continued = false, aborted = false;
    createGuard({ route: (_pattern, callback) => { handler = callback; } });
    await handler({ request: () => ({ method: () => 'GET', url: () => url, postData: () => null }),
      continue: async () => { continued = true; }, abort: async () => { aborted = true; } });
    assert.equal(continued, allowed, url);
    assert.equal(aborted, !allowed, url);
  }
});
