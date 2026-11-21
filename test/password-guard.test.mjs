import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

const cli = (args, env) => execa(process.execPath, ['src/cli.mjs', ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), reject: false });

test('explore refuses to type a password while permitting ordinary search', { timeout: 90000 }, async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<label>Password <input type="password" aria-label="Password"></label><label>Search <input aria-label="Search"></label>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const site = `http://127.0.0.1:${server.address().port}`;
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-password-'));
  const env = { WEB2API_HOME: home };
  t.after(async () => {
    await cli(['explore', 'stop', '--site', site, '--force'], env);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(home, { recursive: true, force: true });
  });
  const start = await cli(['explore', 'start', '--site', site, '--start-url', site], env);
  assert.equal(start.exitCode, 0, start.stdout);
  const snapshot = JSON.parse((await cli(['explore', 'snapshot', '--site', site], env)).stdout).snapshot;
  const password = snapshot.match(/textbox "Password"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  const search = snapshot.match(/textbox "Search"[^\n]*\[ref=((?:f\d+)?e\d+)\]/i)?.[1];
  assert.ok(password && search, snapshot);
  const denied = await cli(['explore', 'type', '--site', site, '--ref', password, '--text', 'DEMO-SECRET'], env);
  assert.equal(denied.exitCode, 1);
  assert.equal(JSON.parse(denied.stdout).error, 'BROWSER_SECRET_INPUT');
  assert.equal(denied.stdout.includes('DEMO-SECRET'), false);
  const allowed = await cli(['explore', 'type', '--site', site, '--ref', search, '--text', 'hello'], env);
  assert.equal(allowed.exitCode, 0, allowed.stdout);
});
