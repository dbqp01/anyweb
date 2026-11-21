import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSite } from '../src/artifact/site.mjs';
import { review } from '../src/commands/review.mjs';

test('browser review shows the allowed query rules before asking for input', async t => {
  const home = await mkdtemp(join(tmpdir(), 'anyweb-review-policy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { WEB2API_HOME: home }, origin = 'http://localhost:12345';
  const recipe = { version: 1, execution: 'browser', id: 'read_note', effect: 'read', input_fields: ['note'], session: null,
    steps: [{ action: 'open', url: `${origin}/notes?action=read`, query: [{ name: 'note', kind: 'input', field: 'note' }] }],
    extract: { mode: 'object', root: '#note', fields: { title: { selector: 'h1' } } }, required_fields: ['title'],
    checks: [{ input: 'note', fields: ['title'] }], observed_at: new Date().toISOString(), discovery: 'demonstration_guided_browser_inference' };
  const policy = [{ origin, path: '/notes', method: 'GET', success: {}, query: [
    { kind: 'literal', name: 'action', value: 'read' }, { kind: 'input', name: 'note', field: 'note' },
  ] }];
  await saveSite({ version: 1, origin, allowed_origins: [], name: 'notes', created_at: new Date().toISOString(), session: null,
    tools: [{ id: 'read_note', goal: 'Read note by identifier', effect: 'read', status: 'proposed', input_fields: ['note'],
      approved_requests: policy, recipe, verification: { status: 'pending', training: 2, held_out: 1, hashes: {} }, reviewed_at: null }],
    evidence: { actions: 0, requests_observed: 2, compiled_at: new Date().toISOString(), engine_hash: 'a'.repeat(64) } }, env);
  const original = process.stderr.write;
  let output = '';
  process.stderr.write = function(chunk) { output += chunk; return true; };
  try { await assert.rejects(review({ site: origin, input: '{}', yes: true }, env), { code: 'INVALID_INPUT' }); }
  finally { process.stderr.write = original; }
  assert.match(output, /allow: GET http:\/\/localhost:12345\/notes/);
  assert.match(output, /query policy:.*"name":"action".*"value":"read"/);
  assert.match(output, /query policy:.*"name":"note".*"field":"note"/);
});
