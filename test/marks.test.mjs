import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarks } from '../src/explore/marks.mjs';

test('marks are idempotent, resettable, and an empty mark does not block the next one', () => {
  const requests = [];
  const recorder = { cursor: () => requests.length, since: cursor => requests.slice(cursor) };
  const actions = { count: 0 };
  const marks = createMarks(recorder, actions);

  const input = { q: 'laptop' };
  assert.equal(marks.begin({ tool: 'search', input, role: 'train' }).duplicate, undefined);
  assert.equal(marks.begin({ tool: 'search', input: { ...input }, role: 'train' }).duplicate, true);
  assert.equal(marks.list().length, 0);

  requests.push({ url: 'https://example.test/api?q=laptop' });
  assert.equal(marks.end().ended, true);
  assert.equal(marks.list().length, 1);
  assert.equal(marks.end().ended, false, 'a retried end must be benign');

  marks.begin({ tool: 'search', input: { q: 'phone' }, role: 'train' });
  assert.throws(() => marks.end(), error => error.code === 'EMPTY_MARK');
  assert.equal(marks.open(), null, 'an empty mark must not leave the recorder open');
  assert.equal(marks.begin({ tool: 'search', input: { q: 'tablet' }, role: 'train' }).phase, 'begin');

  marks.reset();
  assert.equal(marks.list().length, 0);
  assert.equal(marks.open(), null);
});
