import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as explore from '../src/explore/client.mjs';
import { siteFile } from '../src/artifact/site.mjs';
import { startFixture } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, reject: false });

test('browser demonstrations become an approved MCP tool that reads an unseen computed result', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'anyweb-browser-e2e-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env);
    await fixture.close();
  });
  const declaration = join(home, 'declaration.json');
  await writeFile(declaration, JSON.stringify({ version: 1, origin: fixture.origin, name: 'browser-fixture', tools: [{
    id: 'browser_detail', goal: 'Read a product rendered by JavaScript', input_fields: ['product_name'], execution: 'browser',
    extract: { mode: 'object', root: '#browser-detail', fields: { id: { attr: 'data-id' }, name: { selector: 'h1' }, price: { selector: '.price' } } },
  }] }));
  const initialized = await cli(['init', '--file', declaration], env);
  assert.equal(initialized.exitCode, 0, initialized.stdout);
  const started = await cli(['explore', 'start', '--site', fixture.origin, '--start-url', `${fixture.origin}/browser`], env);
  assert.equal(started.exitCode, 0, started.stdout);
  const ref = (snapshot, kind, name) => {
    const match = snapshot.split('\n').find(line => line.includes(`${kind} "${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];
    assert.ok(match, snapshot);
    return match;
  };
  for (const [name, role] of [['Laptop Pro', 'train'], ['Laptop Air', 'train'], ['Phone Max', 'eval']]) {
    await explore.mark(fixture.origin, { phase: 'begin', tool: 'browser_detail', input: { product_name: name }, role }, env);
    const opened = await explore.open(fixture.origin, `${fixture.origin}/browser`, env);
    await explore.type(fixture.origin, ref(opened.snapshot, 'textbox', 'Product'), name, false, env);
    const searched = await explore.click(fixture.origin, ref(opened.snapshot, 'button', 'Search'), env);
    await explore.click(fixture.origin, ref(searched.snapshot, 'button', name), env);
    await explore.mark(fixture.origin, { phase: 'end' }, env);
  }
  const recorded = await explore.marks(fixture.origin, env);
  assert.equal(recorded.marks[0].browser_actions.length, 4);
  assert.equal(recorded.marks[2].browser_output.name, 'Phone Max');
  assert.equal(recorded.marks[2].browser_output.price, '800');
  const proposed = await cli(['propose', '--site', fixture.origin], env);
  assert.equal(proposed.exitCode, 0, proposed.stdout);
  const site = JSON.parse(await readFile(siteFile(fixture.origin, env), 'utf8'));
  assert.equal(site.tools[0].recipe.execution, 'browser');
  assert.equal(site.tools[0].verification.held_out, 1);
  assert.equal(JSON.stringify(site).includes('Laptop'), false);
  const unreviewed = await cli(['package', '--site', fixture.origin], env);
  assert.equal(JSON.parse(unreviewed.stdout).error, 'TOOLS_NOT_APPROVED');
  await explore.stop(fixture.origin, env);
  const review = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(review.exitCode, 0, review.stdout);
  assert.equal(JSON.parse(review.stdout).approved, 1);
  assert.match(review.stderr, /execution: browser/);
  assert.match(review.stderr, /result:.*Laptop Pro/);
  const packaged = await cli(['package', '--site', fixture.origin], env);
  assert.equal(packaged.exitCode, 0, packaged.stdout);
  const payload = JSON.parse(packaged.stdout);
  assert.equal(payload.runtime, 'local_browser_runtime');
  assert.match(await readFile(payload.readme, 'utf8'), /not a standalone HTTP bundle/);
  const evidence = JSON.parse(await readFile(payload.evidence, 'utf8'));
  assert.equal(evidence.tools[0].execution, 'browser');
  const config = Object.values(JSON.parse(await readFile(payload.snippet, 'utf8')).mcpServers)[0];
  assert.equal(config.env.WEB2API_HOME, home);
  const client = new Client({ name: 'browser-e2e', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: config.args,
    env: Object.fromEntries(Object.entries({ ...process.env, ...config.env }).filter(([, value]) => value !== undefined)), stderr: 'pipe' }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['browser_detail']);
  const result = await client.callTool({ name: 'browser_detail', arguments: { product_name: 'Tablet Mini' } });
  assert.ok(!result.isError, JSON.stringify(result));
  const body = JSON.parse(result.content[0].text);
  assert.deepEqual(body.data, { id: 'p4', name: 'Tablet Mini', price: '350' });
  assert.equal(body.evidence.transport, 'browser');
  assert.equal(body.evidence.steps_completed, 4);
  assert.ok(fixture.requests.every(request => request.path === '/browser'));
  assert.equal((await client.callTool({ name: 'browser_detail', arguments: {} })).isError, true);
});
