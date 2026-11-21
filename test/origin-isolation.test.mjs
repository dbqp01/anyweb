import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  downloadsDir, loadDeclarations, loadSite, profileDir, runFile, runLog, saveSite, sessionFile, siteDir, siteFile, siteKey,
} from '../src/artifact/site.mjs';
import { readSession, writeSession } from '../src/session.mjs';
import { clear, status } from '../src/commands/session.mjs';

const tempHome = async t => {
  const home = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-origin-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
};

const exists = path => stat(path).then(() => true, () => false);
const legacyKey = origin => new URL(origin).host.toLowerCase().replace(/[^a-z0-9.-]/g, '_');
const sessionState = value => ({ cookies: [{ name: 'sid', value }], origins: [] });

test('origin keys and every path helper separate colliding origins', async t => {
  const home = await tempHome(t), downloads = join(home, 'downloads');
  const env = { WEB2API_HOME: home, WEB2API_DOWNLOADS: downloads };
  const paths = origin => ({
    siteDir: siteDir(origin, env), siteFile: siteFile(origin, env),
    session: sessionFile(origin, env), namedSession: sessionFile(origin, env, 'work'),
    profile: profileDir(origin, env), namedProfile: profileDir(origin, env, 'work'),
    runFile: runFile(origin, env), runLog: runLog(origin, env), downloads: downloadsDir(origin, env),
  });
  for (const [left, right] of [
    ['https://localhost', 'http://localhost'],
    ['https://a:123', 'https://a_123'],
    ['https://example.com', 'https://example.com:8443'],
  ]) {
    assert.notEqual(siteKey(left), siteKey(right));
    assert.notEqual(paths(left).siteDir, paths(right).siteDir);
    for (const key of Object.keys(paths(left))) assert.notEqual(paths(left)[key], paths(right)[key], `${key} must differ`);
  }
  assert.equal(siteKey('https://EXAMPLE.com:443/path'), siteKey('https://example.com'));
  assert.match(siteKey('https://example.com'), /^[a-f0-9]{64}$/);
});

test('default and named sessions are isolated across colliding origins', async t => {
  const home = await tempHome(t), env = { WEB2API_HOME: home };
  const origins = ['https://localhost', 'http://localhost', 'https://a:123', 'https://a_123'];
  for (const [index, origin] of origins.entries()) {
    await writeSession(origin, sessionState(`default-${index}`), env);
    await writeSession(origin, sessionState(`work-${index}`), env, 'work');
  }
  assert.equal(new Set(origins.map(origin => sessionFile(origin, env))).size, origins.length);
  assert.equal(new Set(origins.map(origin => sessionFile(origin, env, 'work'))).size, origins.length);
  for (const [index, origin] of origins.entries()) {
    assert.equal((await readSession(origin, 'default', env)).cookies[0].value, `default-${index}`);
    assert.equal((await readSession(origin, 'work', env)).cookies[0].value, `work-${index}`);
  }
});

test('legacy session files have no origin proof, so they are preserved and not claimed', async t => {
  const home = await tempHome(t), env = { WEB2API_HOME: home }, origin = 'https://example.com';
  const legacyFile = join(home, 'sessions', `${legacyKey(origin)}.json`);
  const legacyProfile = join(home, 'profiles', legacyKey(origin));
  const legacyState = JSON.stringify(sessionState('legacy-secret'));
  await mkdir(join(home, 'sessions'), { recursive: true });
  await mkdir(legacyProfile, { recursive: true });
  await writeFile(legacyFile, legacyState);

  await assert.rejects(readSession(origin, 'default', env), { code: 'REAUTH_REQUIRED' });
  assert.equal(await readFile(legacyFile, 'utf8'), legacyState);
  assert.equal((await status({ site: origin }, env)).exists, false);
  assert.deepEqual(await clear({ site: origin }, env), { site: origin, cleared: false, profile_cleared: false });
  assert.equal(await exists(legacyFile), true);
  assert.equal(await exists(legacyProfile), true);

  await writeSession(origin, sessionState('fresh'), env);
  await clear({ site: origin }, env);
  assert.equal(await readSession(origin, 'default', env).catch(error => error.code), 'REAUTH_REQUIRED');
  assert.equal(await readFile(legacyFile, 'utf8'), legacyState);
});

const legacySite = origin => ({
  version: 1, origin, allowed_origins: [], name: 'legacy-site',
  created_at: '2026-01-01T00:00:00.000Z', session: null, tools: [],
  evidence: { actions: 0, requests_observed: 0, compiled_at: '2026-01-01T00:00:00.000Z', engine_hash: 'a'.repeat(64) },
});

test('a legacy site.json is read only when its embedded origin matches exactly', async t => {
  const home = await tempHome(t), env = { WEB2API_HOME: home };
  const legacy = join(home, 'sites', 'example.com', 'site.json');
  const original = `${JSON.stringify(legacySite('https://example.com'), null, 2)}\n`;
  await mkdir(join(home, 'sites', 'example.com'), { recursive: true });
  await writeFile(legacy, original);

  const loaded = await loadSite('https://example.com', env);
  assert.equal(loaded.origin, 'https://example.com');
  assert.equal((await loadDeclarations('https://example.com', env)).origin, 'https://example.com');
  await saveSite(loaded, env);
  assert.equal(await exists(siteFile('https://example.com', env)), true);
  assert.notEqual(siteFile('https://example.com', env), legacy);
  assert.equal(await readFile(legacy, 'utf8'), original);
});

test('a legacy file shared by colliding origins is not claimed by the wrong origin', async t => {
  const home = await tempHome(t), env = { WEB2API_HOME: home };
  const legacy = join(home, 'sites', 'localhost', 'site.json');
  const original = `${JSON.stringify(legacySite('https://localhost'), null, 2)}\n`;
  await mkdir(join(home, 'sites', 'localhost'), { recursive: true });
  await writeFile(legacy, original);

  assert.equal((await loadSite('https://localhost', env)).origin, 'https://localhost');
  await assert.rejects(loadSite('http://localhost', env), { code: 'SITE_NOT_FOUND' });
  assert.equal(await readFile(legacy, 'utf8'), original);
});

test('a copied artifact at the new path cannot change the requested origin', async t => {
  const home = await tempHome(t), env = { WEB2API_HOME: home };
  const origin = 'https://example.com', file = siteFile(origin, env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(legacySite('https://other.example')));
  await assert.rejects(loadSite(origin, env), { code: 'INVALID_SITE' });
  await assert.rejects(loadDeclarations(origin, env), { code: 'INVALID_SITE' });
});
