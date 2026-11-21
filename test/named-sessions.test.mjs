import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSession, readSession } from '../src/session.mjs';
import * as sessionModule from '../src/session.mjs';
import { sessionFile, profileDir } from '../src/artifact/site.mjs';
import { clear, status } from '../src/commands/session.mjs';

test('named sessions do not silently use, overwrite or clear the default account', async t => {
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-named-sessions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { WEB2API_HOME: home }, origin = 'https://example.com';
  const standard = { cookies: [{ name: 'sid', value: 'default-test' }], origins: [] };
  const work = { cookies: [{ name: 'sid', value: 'work-test' }], origins: [] };
  await writeSession(origin, standard, env);
  await writeSession(origin, work, env, 'work');
  assert.notEqual(sessionFile(origin, env), sessionFile(origin, env, 'work'));
  assert.notEqual(profileDir(origin, env), profileDir(origin, env, 'work'));
  assert.deepEqual(await readSession(origin, 'default', env), standard);
  assert.deepEqual(await readSession(origin, 'work', env), work);
  await mkdir(profileDir(origin, env, 'work'), { recursive: true });
  assert.equal((await status({ site: origin, session: 'work' }, env)).exists, true);
  const cleared = await clear({ site: origin, session: 'work' }, env);
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.profile_cleared, true);
  assert.deepEqual(await readSession(origin, 'default', env), standard);
  await assert.rejects(readSession(origin, 'work', env), { code: 'REAUTH_REQUIRED' });
});

test('invalid session names cannot traverse the storage path', async t => {
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-invalid-session-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { WEB2API_HOME: home };
  await assert.rejects(writeSession('https://example.com', {}, env, '../other'), { code: 'INVALID_SESSION' });
});

test('simultaneous session saves do not share or leak temporary files', async t => {
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-session-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { WEB2API_HOME: home }, origin = 'https://example.com';
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeSession(origin, { cookies: [{ value: String(i) }], origins: [] }, env)));
  const state = await readSession(origin, 'default', env);
  assert.match(state.cookies[0].value, /^(?:[0-9]|1[01])$/);
  assert.equal((await readdir(join(home, 'sessions'))).some(name => name.endsWith('.tmp')), false);
});

test('saved storage state excludes unrelated SSO cookies and local storage', () => {
  const input = {
    cookies: [
      { name: 'site', domain: 'portal.example.com' },
      { name: 'shared', domain: '.example.com' },
      { name: 'sso', domain: 'accounts.identity.test' },
      { name: 'suffix-attack', domain: '.ample.com' },
      { name: 'sibling', domain: 'other.example.com' },
    ],
    origins: [{ origin: 'https://portal.example.com', localStorage: [] }, { origin: 'https://accounts.identity.test', localStorage: [] }],
  };
  assert.equal(typeof sessionModule.scopeStorageState, 'function');
  const scoped = sessionModule.scopeStorageState('https://portal.example.com', input);
  assert.deepEqual(scoped.cookies.map(c => c.name), ['site', 'shared']);
  assert.deepEqual(scoped.origins.map(o => o.origin), ['https://portal.example.com']);
  assert.equal(input.cookies.length, 5);
});
