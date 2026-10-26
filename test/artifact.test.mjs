import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileRecipe, createRecipeRunner, readWorkflowInput, recipeSchema } from '../src/artifact/recipe.mjs';
import { loadSite, saveSite, siteSchema } from '../src/artifact/site.mjs';
import { startFixture, products } from './fixtures/server.mjs';
import { upstreamJson } from '../src/net/upstream.mjs';
import { redactUrl } from '../src/redact.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const detail = name => products.find(product => product.name === name);

test('recipe v4 compiles and runs a list-to-detail read', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const traces = ['Laptop Pro', 'Laptop Air', 'Phone Max'].map(product_name => ({
    input: { product_name },
    calls: [
      { origin: fixture.origin, path: '/api/products', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200, response: { query: product_name, products } },
      { origin: fixture.origin, path: '/api/product', method: 'GET', encoding: 'query', params: { id: detail(product_name).id }, status: 200, response: detail(product_name) },
    ],
  }));
  const approved = [
    { origin: fixture.origin, path: '/api/products', method: 'GET', allow_json_text: false, success: {} },
    { origin: fixture.origin, path: '/api/product', method: 'GET', allow_json_text: false, success: {} },
  ];
  const recipe = compileRecipe({ id: 'product_detail', traces, approvedRequests: approved });
  assert.equal(recipe.version, 4);
  assert.equal(recipe.effect, 'read');
  assert.deepEqual(recipe.steps[0].params.q, { kind: 'input', field: 'product_name', cast: 'string' });
  assert.equal(recipe.steps[1].params.id.kind, 'selection');
  assert.equal(recipe.steps[1].params.id.match_field, 'name');
  assert.deepEqual(recipe.checks.map(check => check.kind), ['join', 'contains_any']);
  assert.equal(recipeSchema.safeParse({ ...recipe, steps: [{ ...recipe.steps[0], response: 'binary' }, recipe.steps[1]] }).success, false);
  assert.equal(readWorkflowInput(recipe).safeParse({}).success, false);
  assert.throws(() => createRecipeRunner(recipe, approved, {}), /ORIGIN_REJECTED/);
  const run = createRecipeRunner(recipe, approved, { allowLoopback: true });
  const result = await run({ product_name: 'Laptop Pro' });
  assert.equal(result.data.name, 'Laptop Pro');
  assert.equal(result.data.id, 'p1');
  assert.equal(result.evidence.transport, 'http_only');
  assert.equal(result.evidence.calls.length, 2);
  assert.equal(result.evidence.verification.length, 2);
});

test('recipe v4 compiles and runs a single-call search', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const traces = ['Laptop Pro', 'Laptop Air', 'Phone Max'].map(product_name => ({
    input: { product_name },
    calls: [{ origin: fixture.origin, path: '/api/search', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200,
      response: { query: product_name, products: [detail(product_name), { id: 'fuzzy', name: 'Turing Award', price: 0, description: 'fuzzy neighbor' }] } }],
  }));
  const approved = [{ origin: fixture.origin, path: '/api/search', method: 'GET', allow_json_text: false, success: {} }];
  const recipe = compileRecipe({ id: 'search_products', traces, approvedRequests: approved });
  assert.deepEqual(recipe.checks.map(check => check.kind), ['contains_any']);
  assert.equal(recipe.steps.length, 1);
  const run = createRecipeRunner(recipe, approved, { allowLoopback: true });
  const result = await run({ product_name: 'Laptop Pro' });
  assert.equal(result.data.products[0].name, 'Laptop Pro');
  assert.equal(result.evidence.calls.length, 1);
});

test('recipe v4 accepts nullable fields in list items', () => {
  const traces = ['alpha', 'beta'].map(q => ({
    input: { q },
    calls: [{ origin: 'https://example.com', path: '/api/search', method: 'GET', encoding: 'query', params: { q }, status: 200,
      response: { pages: [{ title: `${q} one`, thumbnail: { url: 'u' } }, { title: `${q} two`, thumbnail: null }] } }],
  }));
  const approved = [{ origin: 'https://example.com', path: '/api/search', method: 'GET', allow_json_text: false, success: {} }];
  const recipe = compileRecipe({ id: 'search_pages', traces, approvedRequests: approved });
  assert.equal(recipe.steps[0].shape.fields.pages.item.fields.thumbnail.type, 'nullable');
});

test('recipe v4 accepts a top-level array with nested collections', () => {
  const traces = ['alpha', 'beta'].map(q => ({
    input: { q },
    calls: [{ origin: 'https://example.com', path: '/api/search', method: 'GET', encoding: 'query', params: { q }, status: 200,
      response: [{ categoryId: 1, categoryName: 'all', products: [{ name: `${q} one` }, { name: `${q} two` }] }] }],
  }));
  const approved = [{ origin: 'https://example.com', path: '/api/search', method: 'GET', allow_json_text: false, success: {} }];
  const recipe = compileRecipe({ id: 'search_products', traces, approvedRequests: approved });
  assert.equal(recipe.checks[0].terminal_collection, '0.products');
  assert.equal(recipeSchema.safeParse(recipe).success, true);
});

test('upstream sends an identifying User-Agent', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const body = await upstreamJson(`${fixture.origin}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.match(body.user_agent, /^anyweb-mcp\//);
});

test('recipe v4 compiles and runs a binary download', async t => {
  const fixture = await startFixture();
  const directory = await mkdtemp(join(tmpdir(), 'web2api-download-'));
  t.after(() => fixture.close());
  const names = ['manual.pdf', 'guide.pdf'];
  const traces = names.map(name => ({
    input: { name },
    calls: [{ origin: fixture.origin, path: '/api/file', method: 'GET', encoding: 'query', params: { name }, status: 200,
      response_meta: { content_type: 'application/pdf', bytes: Buffer.byteLength(`PDF:${name}`), sha256: sha256(`PDF:${name}`) } }],
  }));
  const approved = [{ origin: fixture.origin, path: '/api/file', method: 'GET', allow_json_text: false, success: {} }];
  const recipe = compileRecipe({ id: 'download_guide', effect: 'download', traces, approvedRequests: approved });
  assert.equal(recipe.effect, 'download');
  assert.deepEqual(recipe.download.content_types, ['application/pdf']);
  assert.equal(recipe.steps[0].response, 'binary');
  const run = createRecipeRunner(recipe, approved, { allowLoopback: true, downloadDir: directory });
  const result = await run({ name: 'manual.pdf' });
  assert.equal(result.file.content_type, 'application/pdf');
  assert.equal(result.file.bytes, Buffer.byteLength('PDF:manual.pdf'));
  assert.equal(result.file.sha256, sha256('PDF:manual.pdf'));
  assert.equal(await readFile(result.file.path, 'utf8'), 'PDF:manual.pdf');
  assert.equal(result.evidence.effect, 'download');
});

test('site artifact persists recipes and rejects unapproved origins', async t => {
  const fixture = await startFixture();
  const directory = await mkdtemp(join(tmpdir(), 'web2api-home-'));
  t.after(() => fixture.close());
  const traces = ['Laptop Pro', 'Laptop Air'].map(product_name => ({
    input: { product_name },
    calls: [
      { origin: fixture.origin, path: '/api/products', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200, response: { products } },
      { origin: fixture.origin, path: '/api/product', method: 'GET', encoding: 'query', params: { id: detail(product_name).id }, status: 200, response: detail(product_name) },
    ],
  }));
  const approved = [
    { origin: fixture.origin, path: '/api/products', method: 'GET', success: {} },
    { origin: fixture.origin, path: '/api/product', method: 'GET', success: {} },
  ];
  const recipe = compileRecipe({ id: 'product_detail', traces, approvedRequests: approved });
  const site = {
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'product_detail', goal: 'Look up a product by exact name', effect: 'read', status: 'proposed', input_fields: ['product_name'],
      approved_requests: approved, recipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null }],
    evidence: { actions: 0, requests_observed: 0, compiled_at: new Date().toISOString(), engine_hash: 'a'.repeat(64) },
  };
  const env = { WEB2API_HOME: directory };
  const saved = await saveSite(site, env);
  const loaded = await loadSite(fixture.origin, env);
  assert.equal(loaded.tools[0].recipe.steps.length, 2);
  assert.equal(loaded.tools[0].recipe.id, 'product_detail');
  assert.equal(siteSchema.safeParse({ ...saved, tools: [{ ...saved.tools[0], approved_requests: [{ ...approved[0], origin: 'https://evil.example' }] }] }).success, false);
});

test('recipe v4 rejects unreviewed operations and unstable shapes', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const trace = value => ({ input: { q: value }, calls: [{ origin: fixture.origin, path: '/api/products', method: 'GET', encoding: 'query', params: { q: value }, status: 200, response: { value } }] });
  assert.throws(() => compileRecipe({ id: 'broken', traces: [trace('a'), trace('b')], approvedRequests: [] }), /UNREVIEWED_OPERATION/);
  const traces = [trace('a'), trace('b')];
  assert.throws(() => compileRecipe({ id: 'unstable', traces: [{ ...traces[0], calls: [{ ...traces[0].calls[0], response: { value: 1 } }] }, traces[1]], approvedRequests: [{ origin: fixture.origin, path: '/api/products', method: 'GET', success: {} }] }), /RESPONSE_SHAPE_UNSTABLE/);
});

test('recipe v4 allows a public literal token but keeps credentials out', () => {
  const origin = 'https://cdn.example.com';
  const approved = [{ origin, path: '/tweet-result', method: 'GET', success: {} }];
  const trace = (id, token) => ({
    input: { id },
    calls: [{ origin, path: '/tweet-result', method: 'GET', encoding: 'query', params: { id, token }, status: 200, response: { id_str: id, text: `post ${id}` } }],
  });
  const recipe = compileRecipe({ id: 'get_post', traces: [trace('21', '0'), trace('22', '0'), trace('23', '0')], approvedRequests: approved });
  assert.deepEqual(recipe.steps[0].params.token, { kind: 'literal', value: '0' });
  assert.throws(() => compileRecipe({ id: 'get_post', traces: [trace('21', 'secret-value'), trace('22', 'secret-value'), trace('23', 'secret-value')], approvedRequests: approved }), /SECRET_IN_RECIPE/);
  assert.throws(() => compileRecipe({ id: 'get_post', traces: [trace('21', '0'), trace('22', '1'), trace('23', '0')], approvedRequests: approved }), /SECRET_IN_RECIPE/);
});

test('redactUrl keeps public token flags but hides credentials', () => {
  assert.equal(redactUrl('https://cdn.example.com/tweet-result?id=21&token=0'), 'https://cdn.example.com/tweet-result?id=21&token=0');
  assert.equal(redactUrl('https://cdn.example.com/x?access_token=abc'), 'https://cdn.example.com/x?access_token=%5BREDACTED%5D');
  assert.equal(redactUrl('https://cdn.example.com/x?token=secret'), 'https://cdn.example.com/x?token=%5BREDACTED%5D');
});
