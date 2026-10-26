import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { siteFile } from '../../src/artifact/site.mjs';

const ORIGIN = 'https://www.demoblaze.com';
const API = 'https://api.demoblaze.com';
const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const parse = result => JSON.parse(result.stdout);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Demoblaze: explore, propose, review and package a live tool', { skip: process.env.WEB2API_LIVE !== '1', timeout: 600000 }, async t => {
  const items = (await (await fetch(`${API}/entries`)).json()).Items;
  const titles = items.slice(0, 3).map(item => item.title);
  const home = await mkdtemp(join(tmpdir(), 'web2api-live-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => { await cli(['explore', 'stop', '--site', ORIGIN, '--force'], env); });
  const file = siteFile(ORIGIN, env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    version: 1, origin: ORIGIN, allowed_origins: [API], name: 'demoblaze', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'product_detail', goal: 'View a Demoblaze product by exact title', effect: 'read', input_fields: ['product_name'] }],
  }));

  const started = parse(await cli(['explore', 'start', '--site', ORIGIN, '--start-url', ORIGIN, '--budget-actions', '40'], env));
  assert.ok(started.port > 0, started.error);

  const demonstrate = async (product_name, role) => {
    assert.equal((await cli(['explore', 'mark', '--site', ORIGIN, '--tool', 'product_detail', '--input', JSON.stringify({ product_name }), '--role', role], env)).exitCode, 0);
    await cli(['explore', 'open', '--site', ORIGIN, '--url', ORIGIN], env);
    let ref;
    for (let attempt = 0; attempt < 20 && !ref; attempt++) {
      const snapshot = parse(await cli(['explore', 'snapshot', '--site', ORIGIN], env)).snapshot;
      ref = snapshot.match(new RegExp(`link "${escape(product_name)}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`, 'i'))?.[1];
      if (!ref) await sleep(500);
    }
    assert.ok(ref, `product link not in snapshot for ${product_name}`);
    await sleep(500);
    const clicked = await cli(['explore', 'click', '--site', ORIGIN, '--ref', ref], env);
    assert.equal(clicked.exitCode, 0, clicked.stdout);
    await sleep(1000);
    assert.equal(parse(await cli(['explore', 'mark', 'end', '--site', ORIGIN], env)).phase, 'end');
  };
  await demonstrate(titles[0], 'train');
  await demonstrate(titles[1], 'train');
  await demonstrate(titles[2], 'eval');

  const proposed = await cli(['propose', '--site', ORIGIN], env);
  assert.equal(proposed.exitCode, 0, proposed.stdout);
  const recipe = parse(proposed).tools[0];
  assert.equal(recipe.status, 'proposed');
  assert.equal(recipe.steps, 2);
  assert.equal((await cli(['explore', 'stop', '--site', ORIGIN], env)).exitCode, 0);

  const reviewed = await cli(['review', '--site', ORIGIN, '--yes', '--input', JSON.stringify({ product_name: titles[0] })], env);
  assert.equal(reviewed.exitCode, 0, reviewed.stdout);
  assert.equal(parse(reviewed).approved, 1);
  const packaged = await cli(['package', '--site', ORIGIN], env);
  assert.equal(packaged.exitCode, 0, packaged.stdout);

  const client = new Client({ name: 'demoblaze-test', version: '1.0.0' });
  t.after(() => client.close().catch(() => {}));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [parse(packaged).bundle], stderr: 'pipe' }));
  const called = await client.callTool({ name: 'product_detail', arguments: { product_name: titles[2] } });
  assert.ok(!called.isError, JSON.stringify(called));
  const data = JSON.parse(called.content[0].text).data;
  assert.equal(data.title, titles[2]);
  assert.equal(typeof data.price, 'number');
});
