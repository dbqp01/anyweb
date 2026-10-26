import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { siteFile } from '../src/artifact/site.mjs';
import { startFixture } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const parse = result => JSON.parse(result.stdout);

test('propose compiles and verifies two training demos plus one held-out', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-propose-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env);
    await fixture.close();
  });
  const started = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', fixture.origin], env));
  assert.ok(started.port > 0, started.error);

  const demonstrate = async (product_name, role) => {
    const begin = await cli(['explore', 'mark', '--site', fixture.origin, '--tool', 'product_detail', '--input', JSON.stringify({ product_name }), '--role', role], env);
    assert.equal(begin.exitCode, 0, begin.stdout);
    const opened = parse(await cli(['explore', 'open', '--site', fixture.origin, '--url', fixture.origin], env));
    const inputRef = opened.snapshot.match(/textbox[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
    const buttonRef = opened.snapshot.match(/button "Search"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
    assert.ok(inputRef && buttonRef, opened.snapshot);
    assert.equal((await cli(['explore', 'type', '--site', fixture.origin, '--ref', inputRef, '--text', product_name], env)).exitCode, 0);
    const searched = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', buttonRef], env));
    const linkRef = searched.snapshot.match(new RegExp(`link "${product_name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`, 'i'))?.[1];
    assert.ok(linkRef, searched.snapshot);
    assert.equal((await cli(['explore', 'click', '--site', fixture.origin, '--ref', linkRef], env)).exitCode, 0);
    const end = parse(await cli(['explore', 'mark', 'end', '--site', fixture.origin], env));
    assert.ok(end.requests >= 2, JSON.stringify(end));
  };

  await demonstrate('Laptop Pro', 'train');
  await demonstrate('Laptop Air', 'train');
  await demonstrate('Phone Max', 'eval');

  const file = siteFile(fixture.origin, env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'product_detail', goal: 'Look up a product by exact name', effect: 'read', input_fields: ['product_name'] }],
  }));

  const result = await cli(['propose', '--site', fixture.origin], env);
  assert.equal(result.exitCode, 0, result.stdout);
  const proposed = parse(result);
  assert.equal(proposed.tools.length, 1);
  assert.equal(proposed.tools[0].status, 'proposed');
  assert.equal(proposed.tools[0].steps, 2);
  assert.equal(proposed.tools[0].verification.status, 'passed');

  const site = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(site.tools[0].approved_requests.length, 2);
  assert.equal(site.tools[0].recipe.effect, 'read');
  assert.equal(site.tools[0].verification.training, 2);
  assert.equal(site.tools[0].verification.held_out, 1);
  const serialized = JSON.stringify(site);
  for (const value of ['Laptop Pro', 'Laptop Air', 'Phone Max']) assert.equal(serialized.includes(value), false, value);
});
