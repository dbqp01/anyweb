import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createServer } from '../src/mcp/server.mjs';
import { reviewDigest, REVIEW_DIGEST_KEY } from '../src/artifact/review-integrity.mjs';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSite, saveSite } from '../src/artifact/site.mjs';
import { packageSite } from '../src/commands/package.mjs';

function reviewedSite() {
  const origin = 'https://example.com';
  const approved = [{ origin, path: '/api/search', method: 'GET', success: {} }];
  const traces = ['alpha', 'beta'].map(query => ({ input: { query }, calls: [{ origin, path: '/api/search', method: 'GET',
    encoding: 'query', params: { q: query }, status: 200, response: { name: query } }] }));
  const recipe = compileRecipe({ id: 'search_item', traces, approvedRequests: approved });
  const tool = { id: 'search_item', goal: 'Search records by query', effect: 'read', status: 'approved', input_fields: ['query'],
    approved_requests: approved, recipe, verification: { status: 'passed', training: 2, held_out: 1, hashes: {} }, reviewed_at: '2026-01-01T00:00:00.000Z' };
  tool.verification.hashes[REVIEW_DIGEST_KEY] = reviewDigest(tool);
  return { version: 1, name: 'test-site', origin, allowed_origins: [], created_at: new Date().toISOString(), session: null, tools: [tool],
    evidence: { actions: 0, requests_observed: 2, compiled_at: new Date().toISOString(), engine_hash: 'a'.repeat(64) } };
}

test('MCP refuses a stale or missing review before exposing tools', () => {
  const site = reviewedSite();
  site.tools[0].goal = 'Changed after review';
  assert.throws(() => createServer(site), { code: 'REVIEW_STALE' });
  delete site.tools[0].verification.hashes[REVIEW_DIGEST_KEY];
  assert.throws(() => createServer(site), { code: 'REVIEW_STALE' });
});

test('MCP rechecks review immediately before execution', async t => {
  const site = reviewedSite();
  let executions = 0;
  const server = createServer(site, { createRunner: () => async () => { executions++; return { data: {}, evidence: {} }; } });
  const client = new Client({ name: 'review-gate-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  assert.equal((await client.listTools()).tools.length, 1);
  site.tools[0].goal = 'Changed after registration';
  const response = await client.callTool({ name: 'search_item', arguments: { query: 'alpha' } });
  assert.equal(response.isError, true);
  assert.equal(JSON.parse(response.content[0].text).error, 'REVIEW_STALE');
  assert.equal(executions, 0);
});

test('packaging rejects changed or missing review before creating a bundle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'anyweb-review-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { WEB2API_HOME: root };
  const initial = reviewedSite();
  delete initial.tools[0].verification.hashes[REVIEW_DIGEST_KEY];
  await saveSite(initial, env);
  await assert.rejects(packageSite({ site: initial.origin }, env), { code: 'REVIEW_STALE' });
  const site = await loadSite(initial.origin, env);
  site.tools[0].verification.hashes[REVIEW_DIGEST_KEY] = reviewDigest(site.tools[0]);
  site.tools[0].goal = 'Changed after approval';
  await saveSite(site, env);
  await assert.rejects(packageSite({ site: initial.origin }, env), { code: 'REVIEW_STALE' });
});
