import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { startLab } from './lab/server.mjs';
import { writeSession } from '../src/session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = (args, env) => execa(process.execPath, [join(ROOT, 'src/cli.mjs'), ...args], { cwd: ROOT, env: { ...process.env, ...env }, reject: false });
const parse = result => JSON.parse(result.stdout);
const byId = (left, right) => left.id.localeCompare(right.id);

async function login(lab) {
  const response = await fetch(`${lab.origin}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lab.credentials),
  });
  const payload = await response.json();
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  return { response, payload, setCookie, cookie: setCookie.split(';')[0] };
}

function storageState(lab, cookie) {
  const [name, value] = cookie.split('=');
  return {
    cookies: [{ name, value, domain: new URL(lab.origin).hostname, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: lab.origin, localStorage: [] }],
  };
}

test('lab fixture: fictional login, protected read, controlled write and independent oracle', async t => {
  const lab = await startLab();
  t.after(async () => { await lab.close(); await rm(lab.ledgerDir, { recursive: true, force: true }); });

  const anonymous = await fetch(`${lab.origin}/api/notes?tag=work`);
  assert.equal(anonymous.status, 401);

  const forged = await fetch(`${lab.origin}/api/notes?tag=work`, { headers: { cookie: 'lab_sid=forged' } });
  assert.equal(forged.status, 401);

  const rejected = await fetch(`${lab.origin}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...lab.credentials, password: `${lab.credentials.password}-wrong` }),
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('set-cookie'), null);

  const signIn = await login(lab);
  assert.equal(signIn.response.status, 200);
  assert.match(signIn.setCookie, /HttpOnly/i);
  assert.match(signIn.setCookie, /SameSite=Lax/i);
  assert.equal(signIn.payload.user.email, lab.credentials.email);
  assert.ok(signIn.payload.csrf.length >= 32);

  const formSignIn = await fetch(`${lab.origin}/login`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(lab.credentials), redirect: 'manual',
  });
  assert.equal(formSignIn.status, 303);
  assert.equal(formSignIn.headers.get('location'), '/app');
  assert.match(formSignIn.headers.get('set-cookie'), /lab_sid=/);

  const read = await fetch(`${lab.origin}/api/notes?tag=work`, { headers: { cookie: signIn.cookie } });
  assert.equal(read.status, 200);
  const visible = await read.json();
  assert.deepEqual(visible.notes, await lab.oracle.notes('work'));
  assert.ok(visible.notes.length >= 2);

  const note = { id: 'note-lab-1', tag: 'work', text: 'Written by the authenticated lab test' };
  const write = ({ csrf, body = note } = {}) => fetch(`${lab.origin}/api/notes`, {
    method: 'POST',
    headers: { cookie: signIn.cookie, 'content-type': 'application/json', ...(csrf ? { 'x-lab-csrf': csrf } : {}) },
    body: JSON.stringify(body),
  });

  assert.equal((await write()).status, 403);
  assert.equal((await write({ csrf: 'not-the-token' })).status, 403);
  assert.equal((await write({ csrf: signIn.payload.csrf, body: { ...note, admin: true } })).status, 400);
  assert.equal((await write({ csrf: signIn.payload.csrf, body: { ...note, id: 'note upper space' } })).status, 400);
  assert.equal((await lab.oracle.events()).filter(event => event.type === 'note.created').length, 0);

  const created = await write({ csrf: signIn.payload.csrf });
  assert.equal(created.status, 201);
  const { note: written } = await created.json();
  const expected = [...visible.notes, written].sort(byId);
  assert.deepEqual(await lab.oracle.notes('work'), expected);

  const reread = await fetch(`${lab.origin}/api/notes?tag=work`, { headers: { cookie: signIn.cookie } });
  assert.deepEqual((await reread.json()).notes, expected);

  const duplicate = await write({ csrf: signIn.payload.csrf });
  assert.equal(duplicate.status, 409);
  const createdEvents = (await lab.oracle.events()).filter(event => event.type === 'note.created');
  assert.equal(createdEvents.length, 1);
  assert.deepEqual(createdEvents[0].note, written);

  const concurrent = { id: 'note-lab-2', tag: 'home', text: 'Two clients, one id' };
  const [first, second] = await Promise.all([write({ csrf: signIn.payload.csrf, body: concurrent }), write({ csrf: signIn.payload.csrf, body: concurrent })]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const concurrentEvents = (await lab.oracle.events()).filter(event => event.type === 'note.created' && event.note.id === concurrent.id);
  assert.equal(concurrentEvents.length, 1);

  const audit = JSON.stringify(lab.requests);
  assert.ok(!audit.includes(lab.credentials.password), 'audit must not contain the password');
  assert.ok(!audit.includes(signIn.payload.csrf), 'audit must not contain the CSRF token');
  assert.ok(!audit.includes(signIn.cookie.split('=')[1]), 'audit must not contain the session id');
});

test('generated MCP: authenticated read matches the ledger oracle, fails closed, and exposes no write', { timeout: 240000 }, async t => {
  const lab = await startLab();
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-authlab-home-'));
  const writeHome = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-authlab-write-'));
  const env = { WEB2API_HOME: home };
  const signIn = await login(lab);
  const state = storageState(lab, signIn.cookie);
  const sessionPath = await writeSession(lab.origin, state, env, 'lab');
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    await cli(['explore', 'stop', '--site', lab.origin, '--force'], env);
    await lab.close();
    await Promise.all([rm(home, { recursive: true, force: true }), rm(writeHome, { recursive: true, force: true }), rm(lab.ledgerDir, { recursive: true, force: true })]);
  });

  const declaration = join(home, 'declaration.json');
  await writeFile(declaration, JSON.stringify({
    version: 1, origin: lab.origin, allowed_origins: [], name: 'authlab', created_at: new Date().toISOString(), session: 'lab',
    tools: [{ id: 'notes_by_tag', goal: 'List the signed-in account notes with a tag', effect: 'read', input_fields: ['tag'] }],
  }));
  const initialized = await cli(['init', '--file', declaration], env);
  assert.equal(initialized.exitCode, 0, initialized.stdout);

  const started = parse(await cli(['explore', 'start', '--site', lab.origin, '--start-url', `${lab.origin}/app?tag=work`, '--session', 'lab'], env));
  assert.ok(started.port > 0, started.error);

  for (const [tag, role] of [['work', 'train'], ['home', 'train'], ['archive', 'eval']]) {
    const begin = await cli(['explore', 'mark', '--site', lab.origin, '--tool', 'notes_by_tag', '--input', JSON.stringify({ tag }), '--role', role], env);
    assert.equal(begin.exitCode, 0, begin.stdout);
    const opened = await cli(['explore', 'open', '--site', lab.origin, '--url', `${lab.origin}/app?tag=${tag}`], env);
    assert.equal(opened.exitCode, 0, opened.stdout);
    const ended = await cli(['explore', 'mark', 'end', '--site', lab.origin], env);
    assert.equal(ended.exitCode, 0, ended.stdout);
    assert.ok(parse(ended).requests >= 1, ended.stdout);
  }

  const proposed = await cli(['propose', '--site', lab.origin], env);
  assert.equal(proposed.exitCode, 0, proposed.stderr || proposed.stdout);
  assert.equal(parse(proposed).tools[0].verification.status, 'passed');
  const reviewed = await cli(['review', '--site', lab.origin, '--yes', '--input', JSON.stringify({ tag: 'work' })], env);
  assert.equal(reviewed.exitCode, 0, reviewed.stderr);
  assert.equal(parse(reviewed).approved, 1);
  const packaged = parse(await cli(['package', '--site', lab.origin], env));
  assert.deepEqual(packaged.tools, ['notes_by_tag']);
  const bundle = await readFile(packaged.bundle, 'utf8');
  assert.ok(!bundle.includes(lab.credentials.password), 'bundle must not embed the password');
  assert.ok(!bundle.includes(signIn.payload.csrf), 'bundle must not embed the CSRF token');
  assert.ok(!bundle.includes(signIn.cookie.split('=')[1]), 'bundle must not embed the session id');

  const snippet = JSON.parse(await readFile(packaged.snippet, 'utf8')).mcpServers['anyweb-authlab'];
  assert.equal(snippet.env.WEB2API_HOME, home);
  client = new Client({ name: 'authenticated-lab', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: snippet.command, args: snippet.args, stderr: 'pipe',
    env: Object.fromEntries(Object.entries({ ...process.env, ...snippet.env }).filter(([, value]) => value !== undefined)),
  }));
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ['notes_by_tag']);
  assert.equal(listed.tools[0].annotations.readOnlyHint, true);
  const writeTools = listed.tools.filter(tool => tool.annotations.readOnlyHint !== true).length;

  // A write after the demonstrations proves the tool reads live authenticated state, not a replay.
  const late = { id: 'note-live-1', tag: 'work', text: 'Created after the demonstration' };
  const written = await fetch(`${lab.origin}/api/notes`, {
    method: 'POST', headers: { cookie: signIn.cookie, 'x-lab-csrf': signIn.payload.csrf, 'content-type': 'application/json' },
    body: JSON.stringify(late),
  });
  assert.equal(written.status, 201);
  const oracle = await lab.oracle.notes('work');
  assert.ok(oracle.some(note => note.id === late.id));

  const called = await client.callTool({ name: 'notes_by_tag', arguments: { tag: 'work' } });
  assert.ok(!called.isError, JSON.stringify(called));
  assert.deepEqual(JSON.parse(called.content[0].text).data, { notes: oracle });

  const empty = await client.callTool({ name: 'notes_by_tag', arguments: { tag: 'absent' } });
  assert.equal(empty.isError, true);
  assert.equal(JSON.parse(empty.content[0].text).error, 'VERIFICATION_FAILED');

  await writeSession(lab.origin, { ...state, cookies: [{ ...state.cookies[0], value: 'forged' }] }, env, 'lab');
  const expired = await client.callTool({ name: 'notes_by_tag', arguments: { tag: 'work' } });
  assert.equal(expired.isError, true);
  assert.equal(JSON.parse(expired.content[0].text).error, 'REAUTH_REQUIRED');
  assert.deepEqual(await lab.oracle.notes('work'), oracle);

  await rm(sessionPath, { force: true });
  const missing = await client.callTool({ name: 'notes_by_tag', arguments: { tag: 'work' } });
  assert.equal(missing.isError, true);
  assert.equal(JSON.parse(missing.content[0].text).error, 'REAUTH_REQUIRED');
  const authDenials = [expired, missing].filter(call => call.isError).length;

  // Gap probe: the generated MCP has no write tool because the product accepts only read/download.
  const writeDeclaration = join(writeHome, 'declaration.json');
  await writeFile(writeDeclaration, JSON.stringify({
    version: 1, origin: lab.origin, allowed_origins: [], name: 'authlab-write', created_at: new Date().toISOString(), session: 'lab',
    tools: [{ id: 'add_note', goal: 'Create one controlled note', effect: 'write', input_fields: ['tag', 'text'] }],
  }));
  const refusedResult = await cli(['init', '--file', writeDeclaration], { WEB2API_HOME: writeHome });
  assert.equal(refusedResult.exitCode, 1);
  const refused = parse(refusedResult);
  assert.equal(refused.error, 'INVALID_INPUT');
  assert.match(JSON.stringify(refused.issues), /effect/);
  t.diagnostic(`measured: read_tools=${listed.tools.length - writeTools} write_tools=${writeTools} auth_denials=${authDenials} empty_checks=${empty.isError ? 1 : 0} oracle=${lab.oracle.ledgerPath}`);
});
