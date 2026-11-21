import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { loadSite, saveSite } from '../src/artifact/site.mjs';
import { reviewDigest, REVIEW_DIGEST_KEY } from '../src/artifact/review-integrity.mjs';
import { packageSite } from '../src/commands/package.mjs';

const ROOT = process.cwd();
const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice)(\.[a-z0-9]+)?$/i;
const MISSING = 'The installed package ships no license text file.';

const licenseTexts = async dir => {
  const files = (await readdir(dir)).filter(file => LICENSE_FILE.test(file)).sort();
  return Promise.all(files.map(file => readFile(join(dir, file), 'utf8')));
};

// Installed copies, including the nested one npm creates on version conflicts.
const packageDirs = async (dir, depth = 0) => {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = join(dir, entry.name);
    if (entry.name.startsWith('@')) found.push(...await packageDirs(child, depth));
    else {
      found.push(child);
      if (depth < 1) found.push(...await packageDirs(join(child, 'node_modules'), depth + 1));
    }
  }
  return found;
};
let installed;
const installedPackages = async () => {
  if (installed) return installed;
  installed = new Map();
  for (const dir of await packageDirs(join(ROOT, 'node_modules'))) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      const key = `${pkg.name}@${pkg.version}`;
      if (!installed.has(key)) installed.set(key, dir);
    } catch {}
  }
  return installed;
};

// Every notice section must point at an installed package and either quote its shipped text or say there is none.
async function assertNoticesMatchInstall(notices) {
  const packages = await installedPackages();
  const chunks = notices.split('\n## package: ').slice(1);
  assert.ok(chunks.length > 0, 'notices contain no package sections');
  for (const chunk of chunks) {
    const [header, ...rest] = chunk.split('\n\n');
    const match = header.match(/^(\S+) (\S+) — (.+)$/);
    assert.ok(match, `unparseable notice header: ${header}`);
    const [, name, version] = match;
    const dir = packages.get(`${name}@${version}`);
    assert.ok(dir, `${name}@${version} is reported in the notices but is not installed`);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const declared = typeof pkg.license === 'string' ? pkg.license : 'UNKNOWN';
    const body = rest.join('\n\n').trim();
    const texts = (await licenseTexts(dir)).map(text => text.trim());
    if (body.startsWith(MISSING)) {
      assert.equal(texts.length, 0, `${name} ships license text but is reported as missing`);
      assert.ok(body.includes(`Declared license: ${declared}.`), `${name} fallback must state the declared license`);
    } else {
      assert.ok(texts.length > 0, `${name} notice has text but the installed package ships no license file`);
      assert.ok(texts.some(text => body.includes(text)), `${name} notice does not reproduce a shipped license text verbatim`);
    }
  }
}

test('HTTP package ships the complete licenses of every bundled dependency', { timeout: 180000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'web2api-notices-'));
  const env = { WEB2API_HOME: home };
  const origin = 'http://127.0.0.1:9';
  const traces = ['one', 'two'].map(q => ({
    input: { q },
    calls: [{ origin, path: '/api/search', method: 'GET', encoding: 'query', params: { q }, status: 200, response: { title: q } }],
  }));
  const approved = [{ origin, path: '/api/search', method: 'GET', success: {} }];
  await saveSite({
    version: 1, origin, allowed_origins: [], name: 'licenses', created_at: new Date().toISOString(), session: null,
    tools: [{
      id: 'lookup', goal: 'Look up a record by query', effect: 'read', status: 'approved', input_fields: ['q'],
      approved_requests: approved, recipe: compileRecipe({ id: 'lookup', traces, approvedRequests: approved }),
      verification: { status: 'passed', training: 2, held_out: 0, hashes: {} }, reviewed_at: new Date().toISOString(),
    }],
    evidence: { actions: 2, requests_observed: 2, compiled_at: new Date().toISOString(), engine_hash: 'd'.repeat(64) },
  }, env);

  const site = await loadSite(origin, env);
  site.tools[0].verification.hashes[REVIEW_DIGEST_KEY] = reviewDigest(site.tools[0]);
  await saveSite(site, env);

  const result = await packageSite({ site: origin }, env);
  await access(result.bundle);
  await access(result.notices);
  const notices = await readFile(result.notices, 'utf8');

  assert.match(notices, /is not a license for AnyWeb MCP itself/);
  assert.doesNotMatch(notices, /^## package: @akimibks\/anyweb /m);
  await assertNoticesMatchInstall(notices);

  for (const name of ['cheerio', '@modelcontextprotocol/server', 'zod']) {
    assert.match(notices, new RegExp(`^## package: ${name.replace('/', '\\/')} \\d`, 'm'), `${name} is bundled but has no notice`);
  }
  const cheerio = (await readFile(join(ROOT, 'node_modules', 'cheerio', 'LICENSE'), 'utf8')).trim();
  assert.ok(notices.includes(cheerio), 'cheerio license text is not reproduced in full');
  assert.doesNotMatch(notices, /^## package: playwright /m, 'playwright is not bundled into an HTTP package');

  const readme = await readFile(result.readme, 'utf8');
  assert.ok(readme.includes('THIRD_PARTY_NOTICES.txt'));
});
