import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { siteFile } from '../src/artifact/site.mjs';
import { startFixture } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const parse = result => JSON.parse(result.stdout);

test('html extraction: explore, propose, review, package, call over MCP', { timeout: 180000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-html-'));
  const downloads = await mkdtemp(join(tmpdir(), 'web2api-html-downloads-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env);
    await fixture.close();
  });
  const file = siteFile(fixture.origin, env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [{
      id: 'search_products', goal: 'Search products by name', effect: 'read', input_fields: ['query'],
      extract: {
        mode: 'list', root: 'li.result',
        fields: {
          id: { attr: 'data-id' }, name: { selector: '.name' }, price: { selector: '.price' },
          url: { selector: 'a', attr: 'href', absolute: true },
        },
      },
    }],
  }));

  const started = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', fixture.origin], env));
  assert.ok(started.port > 0, started.error);

  const demonstrate = async (query, role) => {
    const begin = await cli(['explore', 'mark', '--site', fixture.origin, '--tool', 'search_products', '--input', JSON.stringify({ query }), '--role', role], env);
    assert.equal(begin.exitCode, 0, begin.stdout);
    const opened = parse(await cli(['explore', 'open', '--site', fixture.origin, '--url', `${fixture.origin}/html/search?q=${encodeURIComponent(query)}`], env));
    assert.match(opened.url, /\/html\/search/);
    const end = parse(await cli(['explore', 'mark', 'end', '--site', fixture.origin], env));
    assert.equal(end.phase, 'end');
  };
  await demonstrate('laptop', 'train');
  await demonstrate('phone', 'train');
  await demonstrate('air', 'eval');

  const proposed = await cli(['propose', '--site', fixture.origin], env);
  assert.equal(proposed.exitCode, 0, proposed.stdout);
  const site = JSON.parse(await readFile(file, 'utf8'));
  const recipe = site.tools[0].recipe;
  assert.equal(recipe.steps[0].response, 'html');
  assert.equal(recipe.steps[0].extract.root, 'li.result');
  assert.equal(recipe.steps[0].shape.type, 'object');
  assert.equal(recipe.checks[0].kind, 'contains_any');
  assert.equal(site.tools[0].verification.status, 'passed');
  assert.equal((await cli(['explore', 'stop', '--site', fixture.origin], env)).exitCode, 0);

  const reviewed = await cli(['review', '--site', fixture.origin, '--yes', '--input', JSON.stringify({ query: 'laptop' })], env);
  assert.equal(reviewed.exitCode, 0, reviewed.stdout);
  assert.equal(parse(reviewed).approved, 1);
  const packaged = await cli(['package', '--site', fixture.origin], env);
  assert.equal(packaged.exitCode, 0, packaged.stdout);

  const client = new Client({ name: 'html-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [parse(packaged).bundle],
    env: Object.fromEntries(Object.entries({ ...process.env, WEB2API_DOWNLOADS: downloads }).filter(([, value]) => value !== undefined)), stderr: 'pipe' }));
  const called = await client.callTool({ name: 'search_products', arguments: { query: 'air' } });
  assert.ok(!called.isError, JSON.stringify(called));
  const data = JSON.parse(called.content[0].text).data;
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].name, 'Laptop Air');
  assert.equal(data.items[0].id, 'p2');
  assert.equal(data.items[0].url, `${fixture.origin}/product?id=p2`);
});
