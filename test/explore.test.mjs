import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { runFile } from '../src/artifact/site.mjs';
import { startFixture } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd() });
const parse = result => JSON.parse(result.stdout);

test('explore daemon drives the fixture and cleans up', { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-explore-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env).catch(() => {});
    await fixture.close();
  });
  const started = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', fixture.origin], env));
  assert.equal(started.site, fixture.origin);
  assert.ok(started.port > 0);

  const initial = parse(await cli(['explore', 'snapshot', '--site', fixture.origin], env));
  const inputRef = initial.snapshot.match(/textbox[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  const buttonRef = initial.snapshot.match(/button "Search"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  assert.ok(inputRef, initial.snapshot);
  assert.ok(buttonRef, initial.snapshot);

  await cli(['explore', 'type', '--site', fixture.origin, '--ref', inputRef, '--text', 'Laptop'], env);
  const clicked = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', buttonRef], env));
  assert.ok(clicked.requests.some(request => request.url.includes('/api/products')), JSON.stringify(clicked.requests));

  const results = parse(await cli(['explore', 'snapshot', '--site', fixture.origin], env));
  const linkRef = results.snapshot.match(/link "Laptop Pro"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  assert.ok(linkRef, results.snapshot);
  const detail = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', linkRef], env));
  assert.ok(detail.requests.some(request => request.url.includes('/api/product')), JSON.stringify(detail.requests));
  assert.match(detail.snapshot, /Laptop Pro/);

  const shot = parse(await cli(['explore', 'screenshot', '--site', fixture.origin], env));
  await access(shot.path);
  const status = parse(await cli(['explore', 'status', '--site', fixture.origin], env));
  assert.equal(status.site, fixture.origin);

  const stopped = parse(await cli(['explore', 'stop', '--site', fixture.origin], env));
  assert.equal(stopped.stopped, true);
  await assert.rejects(access(runFile(fixture.origin, env)));
});
