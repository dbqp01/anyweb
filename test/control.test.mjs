import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { call } from '../src/explore/client.mjs';
import { startFixture } from './fixtures/server.mjs';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });
const parse = result => JSON.parse(result.stdout);
const waitFor = async (predicate, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
  return false;
};

async function boot(t, extra = []) {
  const fixture = await startFixture();
  const home = await mkdtemp(join(tmpdir(), 'web2api-control-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', fixture.origin, '--force'], env);
    await fixture.close();
  });
  const started = parse(await cli(['explore', 'start', '--site', fixture.origin, '--start-url', fixture.origin, ...extra], env));
  assert.ok(started.port > 0, started.error);
  return { fixture, home, env };
}

test('destructive requests wait for a single-use confirmation', { timeout: 90000 }, async t => {
  const { fixture, env } = await boot(t);
  const initial = parse(await cli(['explore', 'snapshot', '--site', fixture.origin], env));
  const ref = initial.snapshot.match(/button "Delete item"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  assert.ok(ref, initial.snapshot);
  const blocked = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', ref], env));
  assert.equal(blocked.confirmation_required?.code, 'CONFIRM_REQUIRED');
  assert.equal(blocked.blocked[0].method, 'DELETE');
  assert.ok(!fixture.requests.some(request => request.method === 'DELETE'));
  const confirmed = parse(await cli(['explore', 'confirm', '--site', fixture.origin, '--nonce', blocked.blocked[0].nonce], env));
  assert.equal(confirmed.confirmed, true);
  const allowed = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', ref], env));
  assert.equal(allowed.confirmation_required, undefined);
  assert.ok(await waitFor(() => fixture.requests.some(request => request.method === 'DELETE')));
});

test('budget stops actions but keeps status and stop available', { timeout: 90000 }, async t => {
  const { fixture, env } = await boot(t, ['--budget-actions', '1']);
  const initial = parse(await cli(['explore', 'snapshot', '--site', fixture.origin], env));
  const ref = initial.snapshot.match(/button "Search"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  assert.ok(ref, initial.snapshot);
  const first = await cli(['explore', 'click', '--site', fixture.origin, '--ref', ref], env);
  assert.equal(first.exitCode, 0, first.stdout);
  const second = await cli(['explore', 'click', '--site', fixture.origin, '--ref', ref], env);
  assert.equal(second.exitCode, 1);
  assert.equal(parse(second).error, 'BUDGET_EXHAUSTED');
  const status = parse(await cli(['explore', 'status', '--site', fixture.origin], env));
  assert.equal(status.budget.actions, 1);
  assert.equal(status.budget.max_actions, 1);
});

test('marks capture a demonstration with its inputs and requests', { timeout: 120000 }, async t => {
  const { fixture, env } = await boot(t);
  const demonstrate = async product_name => {
    const begin = await cli(['explore', 'mark', '--site', fixture.origin, '--tool', 'product_detail', '--input', JSON.stringify({ product_name }), '--role', product_name === 'Laptop Pro' ? 'train' : 'eval'], env);
    assert.equal(begin.exitCode, 0, begin.stdout);
    const opened = parse(await cli(['explore', 'open', '--site', fixture.origin, '--url', fixture.origin], env));
    const inputRef = opened.snapshot.match(/textbox[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
    const buttonRef = opened.snapshot.match(/button "Search"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
    assert.ok(inputRef && buttonRef, opened.snapshot);
    await cli(['explore', 'type', '--site', fixture.origin, '--ref', inputRef, '--text', product_name], env);
    const searched = parse(await cli(['explore', 'click', '--site', fixture.origin, '--ref', buttonRef], env));
    const linkRef = searched.snapshot.match(new RegExp(`link "${product_name}"[^\\n]*\\[ref=((?:f\\d+)?e\\d+)\\]`, 'i'))?.[1];
    assert.ok(linkRef, searched.snapshot);
    await cli(['explore', 'click', '--site', fixture.origin, '--ref', linkRef], env);
    const end = parse(await cli(['explore', 'mark', 'end', '--site', fixture.origin], env));
    assert.equal(end.phase, 'end');
    assert.ok(end.requests >= 2, JSON.stringify(end));
  };
  await demonstrate('Laptop Pro');
  await demonstrate('Laptop Air');
  const recorded = await call(fixture.origin, '/marks', { method: 'GET' }, env);
  assert.equal(recorded.marks.length, 2);
  assert.deepEqual(recorded.marks[0].input, { product_name: 'Laptop Pro' });
  assert.equal(recorded.marks[0].role, 'train');
  assert.ok(recorded.marks[0].requests.some(request => request.url.includes('/api/products')));
  assert.ok(recorded.marks[0].requests.some(request => request.url.includes('/api/product')));
});
