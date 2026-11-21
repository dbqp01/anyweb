import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { downloadsDir, loadSite, saveSite } from '../src/artifact/site.mjs';
import { review } from '../src/commands/review.mjs';
import { startFixture } from './fixtures/server.mjs';

test('review writes downloads only to the configured environment directory', async t => {
  const fixture = await startFixture();
  const root = await mkdtemp(join(tmpdir(), 'anyweb-review-download-'));
  const previous = process.env.WEB2API_DOWNLOADS;
  process.env.WEB2API_DOWNLOADS = join(root, 'wrong');
  t.after(async () => {
    if (previous === undefined) delete process.env.WEB2API_DOWNLOADS;
    else process.env.WEB2API_DOWNLOADS = previous;
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  });
  const env = { WEB2API_HOME: join(root, 'home'), WEB2API_DOWNLOADS: join(root, 'expected') };
  const approved = [{ origin: fixture.origin, path: '/api/file', method: 'GET', success: {} }];
  const traces = ['manual.pdf', 'guide.pdf'].map(name => ({ input: { name }, calls: [{ origin: fixture.origin,
    path: '/api/file', method: 'GET', encoding: 'query', params: { name }, status: 200,
    response_meta: { content_type: 'application/pdf', bytes: Buffer.byteLength(`PDF:${name}`),
      sha256: createHash('sha256').update(`PDF:${name}`).digest('hex') } }] }));
  const recipe = compileRecipe({ id: 'download_guide', effect: 'download', traces, approvedRequests: approved });
  await saveSite({ version: 1, origin: fixture.origin, allowed_origins: [], name: 'fixture', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'download_guide', goal: 'Download requested guide', effect: 'download', status: 'proposed', input_fields: ['name'],
      approved_requests: approved, recipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null }],
    evidence: { actions: 0, requests_observed: 2, compiled_at: new Date().toISOString(), engine_hash: 'a'.repeat(64) } }, env);
  const result = await review({ site: fixture.origin, input: JSON.stringify({ name: 'manual.pdf' }), yes: true }, env);
  assert.equal(result.approved, 1);
  const reviewed = await loadSite(fixture.origin, env);
  assert.match(reviewed.tools[0].verification.hashes.review_digest, /^[a-f0-9]{64}$/);
  assert.equal((await readdir(downloadsDir(fixture.origin, env))).length, 1);
  await assert.rejects(readdir(downloadsDir(fixture.origin, { WEB2API_DOWNLOADS: process.env.WEB2API_DOWNLOADS })), { code: 'ENOENT' });
  const oldDigest = reviewed.tools[0].verification.hashes.review_digest;
  reviewed.tools[0].goal = 'Download requested guide after change';
  await saveSite(reviewed, env);
  assert.equal((await review({ site: fixture.origin, input: JSON.stringify({ name: 'guide.pdf' }), yes: true }, env)).reviewed, 1);
  assert.notEqual((await loadSite(fixture.origin, env)).tools[0].verification.hashes.review_digest, oldDigest);
});
