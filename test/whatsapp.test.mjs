import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const envOf = extra => Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([, value]) => value !== undefined));
const tools = ['whatsapp_get_messages', 'whatsapp_list_chats', 'whatsapp_search_messages', 'whatsapp_status'];

test('packages a standalone read-only MCP and reports missing pairing', { timeout: 180000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'web2api-whatsapp-'));
  const env = { WEB2API_HOME: home };
  const packaged = await cli(['whatsapp', 'package'], env);
  assert.equal(packaged.exitCode, 0, packaged.stdout + packaged.stderr);
  const payload = JSON.parse(packaged.stdout);
  assert.equal(payload.auth, false);
  assert.deepEqual(payload.tools.sort(), tools);
  assert.match(await readFile(payload.bundle, 'utf8'), /createWhatsAppRunner/);
  const code = await readFile(payload.bundle, 'utf8');
  assert.equal(/\bplaywright\b/i.test(code), false);

  const snippet = JSON.parse(await readFile(payload.snippet, 'utf8'));
  const entry = snippet.mcpServers['anyweb-whatsapp'];
  assert.equal(entry.command, 'node');
  assert.equal(entry.env.WEB2API_WHATSAPP_AUTH, payload.auth_dir);
  assert.equal(entry.env.WEB2API_HOME, home);
  const evidence = JSON.parse(await readFile(payload.evidence, 'utf8'));
  assert.equal(evidence.read_only, true);
  assert.deepEqual(evidence.tools.sort(), tools);

  const client = new Client({ name: 'whatsapp-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [payload.bundle],
    env: envOf({ WEB2API_HOME: home, WEB2API_WHATSAPP_AUTH: payload.auth_dir }), stderr: 'pipe',
  }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), tools);
  assert.equal(listed.tools.every(tool => tool.annotations?.readOnlyHint === true), true);
  assert.equal(listed.tools.every(tool => tool.annotations?.openWorldHint === true), true);

  const status = await client.callTool({ name: 'whatsapp_status', arguments: {} });
  assert.ok(!status.isError, JSON.stringify(status));
  const statusResult = JSON.parse(status.content[0].text);
  assert.equal(statusResult.data.state, 'awaiting_pairing');
  assert.match(statusResult.evidence.limits.join(' '), /persisted.*store\.json/i);
  assert.doesNotMatch(statusResult.evidence.limits.join(' '), /resets on restart/i);

  const chats = await client.callTool({ name: 'whatsapp_list_chats', arguments: {} });
  assert.equal(chats.isError, true);
  assert.equal(JSON.parse(chats.content[0].text).error, 'SESSION_NOT_CONFIGURED');
});

test('logout requires confirmation and clears a missing auth dir', async () => {
  const home = await mkdtemp(join(tmpdir(), 'web2api-whatsapp-'));
  const env = { WEB2API_HOME: home };
  const refused = await cli(['whatsapp', 'logout'], env);
  assert.equal(refused.exitCode, 1);
  assert.equal(JSON.parse(refused.stdout).error, 'CONFIRMATION_REQUIRED');
  const cleared = await cli(['whatsapp', 'logout', '--yes'], env);
  assert.equal(cleared.exitCode, 0, cleared.stdout + cleared.stderr);
  assert.equal(JSON.parse(cleared.stdout).cleared, false);
});
