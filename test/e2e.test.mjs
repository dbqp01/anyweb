import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startFixture } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const parse = result => JSON.parse(result.stdout);

test('full loop: explore, propose, review, package, call over MCP', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-e2e-'));
  const downloads = await mkdtemp(join(tmpdir(), 'web2api-e2e-downloads-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env);
    await fixture.close();
  });
  const file = join(home, 'declaration.json');
  await writeFile(file, JSON.stringify({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'product_detail', goal: 'Look up a product by exact name', effect: 'read', input_fields: ['product_name'] }],
  }));

  const initialized = await cli(['init', '--file', file], env);
  assert.equal(initialized.exitCode, 0, initialized.stdout);
  const started = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', fixture.origin], env));
  assert.ok(started.port > 0, started.error);

  const demonstrate = async (product_name, role) => {
    assert.equal((await cli(['explore', 'mark', '--site', fixture.origin, '--tool', 'product_detail', '--input', JSON.stringify({ product_name }), '--role', role], env)).exitCode, 0);
    const opened = parse(await cli(['explore', 'open', '--site', fixture.origin, '--url', fixture.origin], env));
    const inputRef = opened.snapshot.match(/textbox[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
    const buttonRef = opened.snapshot.match(/button "Search"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
    assert.ok(inputRef && buttonRef, opened.snapshot);
    await cli(['explore', 'type', '--site', fixture.origin, '--ref', inputRef, '--text', product_name], env);
    const searched = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', buttonRef], env));
    const linkRef = searched.snapshot.match(new RegExp(`link "${product_name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`, 'i'))?.[1];
    assert.ok(linkRef, searched.snapshot);
    await cli(['explore', 'click', '--site', fixture.origin, '--ref', linkRef], env);
    assert.equal(parse(await cli(['explore', 'mark', 'end', '--site', fixture.origin], env)).phase, 'end');
  };
  await demonstrate('Laptop Pro', 'train');
  await demonstrate('Laptop Air', 'train');
  await demonstrate('Phone Max', 'eval');

  const proposed = await cli(['propose', '--site', fixture.origin], env);
  assert.equal(proposed.exitCode, 0, proposed.stdout);
  assert.equal(parse(proposed).tools[0].status, 'proposed');
  assert.equal((await cli(['explore', 'stop', '--site', fixture.origin], env)).exitCode, 0);

  const reviewed = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ product_name: 'Laptop Pro' })], env);
  assert.equal(reviewed.exitCode, 0, reviewed.stdout);
  assert.equal(parse(reviewed).approved, 1);
  const packaged = await cli(['package', '--site', fixture.origin], env);
  assert.equal(packaged.exitCode, 0, packaged.stdout);

  const client = new Client({ name: 'e2e-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [parse(packaged).bundle],
    env: Object.fromEntries(Object.entries({ ...process.env, WEB2API_DOWNLOADS: downloads }).filter(([, value]) => value !== undefined)), stderr: 'pipe' }));
  const called = await client.callTool({ name: 'product_detail', arguments: { product_name: 'Laptop Air' } });
  assert.ok(!called.isError, JSON.stringify(called));
  assert.equal(JSON.parse(called.content[0].text).data.name, 'Laptop Air');
});
