import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { saveSite, siteFile } from '../src/artifact/site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const envOf = extra => Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([, value]) => value !== undefined));
const payload = result => JSON.parse(result.content[0].text);
const declaration = {
  version: 1, origin: 'https://example.com', name: 'example',
  tools: [{ id: 'search_items', goal: 'Find items matching a query', input_fields: ['query'] }],
};

test('factory MCP handshakes over stdio and exposes only bounded factory tools', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'anyweb-factory-'));
  const env = { WEB2API_HOME: home };
  t.after(() => rm(home, { recursive: true, force: true }));

  const client = new Client({ name: 'factory-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(ROOT, 'src/cli.mjs'), 'mcp'],
    env: envOf(env),
    stderr: 'pipe',
  }));

  assert.equal(client.getServerVersion().name, 'anyweb-factory');
  const names = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'explore_click', 'explore_open', 'explore_requests', 'explore_snapshot', 'explore_start',
    'explore_status', 'explore_stop', 'explore_type', 'init_site', 'mark_begin', 'mark_end',
    'marks_list', 'propose_tools', 'site_status',
  ]);
  for (const forbidden of ['confirm', 'review', 'approve', 'package', 'login', 'session_login', 'shell', 'exec']) {
    assert.equal(names.includes(forbidden), false, `${forbidden} must not be exposed`);
  }

  const created = await client.callTool({ name: 'init_site', arguments: declaration });
  assert.notEqual(created.isError, true, JSON.stringify(created.content));
  const init = payload(created);
  assert.equal(init.site, declaration.origin);
  assert.deepEqual(init.tools, ['search_items']);
  assert.equal(init.next, 'explore start');
  assert.equal(init.file, undefined, 'the internal path is not part of the contract');
  const saved = JSON.parse(await readFile(siteFile(declaration.origin, env), 'utf8'));
  assert.equal(saved.tools[0].effect, 'read');

  const status = payload(await client.callTool({ name: 'site_status', arguments: { site: declaration.origin } }));
  assert.equal(status.stage, 'declared');
  assert.equal(status.tools[0].status, 'draft');
  assert.equal(status.evidence, null);

  const approved = [{ origin: declaration.origin, path: '/api/items', method: 'GET', success: {} }];
  const traces = ['alpha', 'beta'].map(query => ({
    input: { query },
    calls: [{ origin: declaration.origin, path: '/api/items', method: 'GET', encoding: 'query', params: { query }, status: 200, response: { items: [{ name: query }] } }],
  }));
  const recipe = compileRecipe({ id: 'search_items', traces, approvedRequests: approved });
  await saveSite({
    version: 1, origin: declaration.origin, allowed_origins: [], name: 'example', created_at: new Date().toISOString(), session: null,
    tools: [{
      id: 'search_items', goal: 'Find items matching a query', effect: 'read', status: 'proposed', input_fields: ['query'],
      approved_requests: approved, recipe, verification: { status: 'passed', training: 2, held_out: 1, hashes: {} }, reviewed_at: null,
    }],
    evidence: { actions: 2, requests_observed: 2, compiled_at: new Date().toISOString(), engine_hash: 'b'.repeat(64) },
  }, env);
  const compiled = payload(await client.callTool({ name: 'site_status', arguments: { site: declaration.origin } }));
  assert.equal(compiled.stage, 'compiled');
  assert.equal(compiled.tools[0].status, 'proposed');
  assert.equal(compiled.tools[0].verification, 'passed');
  assert.equal(compiled.evidence.actions, 2);
  assert.equal(JSON.stringify(compiled).includes('alpha'), false, 'recipes and responses are not returned');

  const duplicate = await client.callTool({ name: 'init_site', arguments: declaration });
  assert.equal(duplicate.isError, true);
  assert.equal(payload(duplicate).error, 'SITE_ALREADY_EXISTS');

  const offline = await client.callTool({ name: 'explore_status', arguments: { site: declaration.origin } });
  assert.equal(offline.isError, true);
  assert.equal(payload(offline).error, 'DAEMON_NOT_RUNNING');

  const undeclared = await client.callTool({ name: 'explore_start', arguments: { site: 'https://example.org', start_url: 'https://example.org/' } });
  assert.equal(undeclared.isError, true);
  assert.equal(payload(undeclared).error, 'SITE_NOT_FOUND');

  const outside = await client.callTool({ name: 'explore_open', arguments: { site: declaration.origin, url: 'https://example.org/' } });
  assert.equal(outside.isError, true);
  assert.equal(payload(outside).error, 'INVALID_ORIGIN');

  const credentials = await client.callTool({ name: 'explore_open', arguments: { site: declaration.origin, url: 'https://user:secret@example.com/' } });
  assert.equal(credentials.isError, true);
  assert.equal(payload(credentials).error, 'INVALID_INPUT');

  const secretQuery = await client.callTool({ name: 'explore_open', arguments: { site: declaration.origin, url: 'https://example.com/?sesskey=DEMO-SECRET' } });
  assert.equal(secretQuery.isError, true);
  assert.equal(payload(secretQuery).error, 'BROWSER_SECRET_INPUT');
  assert.equal(JSON.stringify(secretQuery).includes('DEMO-SECRET'), false);
});
