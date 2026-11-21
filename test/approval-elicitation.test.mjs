import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { canonicalRequest, withApproval } from '../src/approval/elicitation.mjs';

const REQUEST = {
  method: 'POST',
  url: 'https://example.com/api/items?mode=create',
  body: '{"name":"alpha"}',
  contentType: 'application/json',
};

async function harness(t, { capabilities, elicitation } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'approval-test', version: '1.0.0' });
  const runs = [];

  server.registerTool('perform_write', { inputSchema: z.object({}) }, async (_args, ctx) => {
    try {
      const result = await withApproval(
        { request: REQUEST, elicit: ctx.mcpReq.elicitInput, signal: ctx.mcpReq.signal },
        () => {
          runs.push('run');
          return 'executed';
        },
      );
      return { content: [{ type: 'text', text: JSON.stringify({ result, runs: runs.length }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code, reason: error.reason, runs: runs.length }) }] };
    }
  });

  const client = new Client(
    { name: 'approval-client', version: '1.0.0' },
    capabilities === undefined ? undefined : { capabilities },
  );
  if (elicitation) client.setRequestHandler('elicitation/create', elicitation);

  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    runs,
    call: () => client.callTool({ name: 'perform_write', arguments: {} }),
  };
}

const payload = response => JSON.parse(response.content[0].text);

test('accept runs the callback once per call and shows the exact canonical request', async t => {
  const seen = [];
  const { call, runs } = await harness(t, {
    capabilities: { elicitation: {} },
    elicitation: async request => {
      seen.push(request.params);
      return { action: 'accept', content: { approve: true } };
    },
  });

  for (const expectedRuns of [1, 2]) {
    const response = await call();
    assert.notEqual(response.isError, true);
    assert.deepEqual(payload(response), { result: 'executed', runs: expectedRuns });
  }

  assert.deepEqual(runs, ['run', 'run']);
  assert.equal(seen.length, 2, 'a second call must ask again; acceptance is not a reusable token');
  for (const params of seen) {
    assert.equal(params.mode, 'form');
    assert.ok(params.message.includes(canonicalRequest(REQUEST)));
    assert.ok(params.message.includes('application/json'));
    assert.deepEqual(params.requestedSchema, {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title: 'Approve this exact request',
          description: 'Runs only this request, once. No standing permission is granted.',
        },
      },
      required: ['approve'],
    });
  }
});

test('decline returns a typed failure and never invokes the callback', async t => {
  const { call, runs } = await harness(t, {
    capabilities: { elicitation: {} },
    elicitation: async () => ({ action: 'decline' }),
  });

  const response = await call();
  assert.equal(response.isError, true);
  assert.deepEqual(payload(response), { code: 'APPROVAL_DECLINED', runs: 0 });
  assert.deepEqual(runs, []);
});

test('cancel returns a typed failure and never invokes the callback', async t => {
  const { call, runs } = await harness(t, {
    capabilities: { elicitation: {} },
    elicitation: async () => ({ action: 'cancel' }),
  });

  const response = await call();
  assert.equal(response.isError, true);
  assert.deepEqual(payload(response), { code: 'APPROVAL_CANCELLED', runs: 0 });
  assert.deepEqual(runs, []);
});

test('a client without the elicitation capability fails closed without a callback', async t => {
  const { call, runs } = await harness(t);

  const response = await call();
  assert.equal(response.isError, true);
  assert.deepEqual(payload(response), { code: 'APPROVAL_UNAVAILABLE', reason: 'CAPABILITY_ABSENT', runs: 0 });
  assert.deepEqual(runs, []);
});

test('a failing elicitation request fails closed without a callback', async t => {
  const { call, runs } = await harness(t, {
    capabilities: { elicitation: {} },
    elicitation: async () => { throw new Error('prompt failed'); },
  });

  const response = await call();
  assert.equal(response.isError, true);
  assert.deepEqual(payload(response), { code: 'APPROVAL_UNAVAILABLE', reason: 'ELICITATION_FAILED', runs: 0 });
  assert.deepEqual(runs, []);
});

test('accept without an explicit true approval fails closed', async t => {
  const { call, runs } = await harness(t, {
    capabilities: { elicitation: {} },
    elicitation: async () => ({ action: 'accept', content: { approve: false } }),
  });

  const response = await call();
  assert.equal(response.isError, true);
  assert.deepEqual(payload(response), { code: 'APPROVAL_NOT_CONFIRMED', runs: 0 });
  assert.deepEqual(runs, []);
});

test('canonicalRequest rejects credentials and withApproval fails without an elicitor', async () => {
  assert.equal(
    canonicalRequest({ method: 'POST', url: 'https://example.com/a#fragment' }),
    JSON.stringify({ method: 'POST', url: 'https://example.com/a' }, null, 2),
  );
  assert.throws(
    () => canonicalRequest({ method: 'POST', url: 'https://user:secret@example.com/a' }),
    error => error.code === 'INVALID_APPROVAL_REQUEST',
  );
  assert.throws(
    () => canonicalRequest({ method: 'POST', url: 'https://example.com/a', headers: { authorization: 'secret' } }),
    error => error.code === 'INVALID_APPROVAL_REQUEST',
  );

  let ran = false;
  await assert.rejects(
    withApproval({ request: REQUEST }, () => { ran = true; }),
    error => error.code === 'APPROVAL_UNAVAILABLE' && error.reason === 'NO_ELICITATION',
  );
  assert.equal(ran, false);
});

test('approval freezes and passes the exact snapshot even when the original request changes', async () => {
  const request = { ...REQUEST }, shown = [];
  const snapshot = await withApproval({ request, elicit: async message => {
    shown.push(message.message);
    request.url = 'https://elsewhere.example/evil';
    request.body = '{"name":"changed"}';
    request.contentType = 'text/plain';
    return { action: 'accept', content: { approve: true } };
  } }, approved => approved);
  assert.deepEqual(snapshot, REQUEST);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(shown[0].includes(canonicalRequest(REQUEST)));
  assert.equal(shown[0].includes('elsewhere.example'), false);
});

test('body is bounded, cannot contain control characters and requires content type', () => {
  assert.throws(() => canonicalRequest({ method: 'POST', url: REQUEST.url, body: '{}' }), { code: 'INVALID_APPROVAL_REQUEST' });
  assert.throws(() => canonicalRequest({ ...REQUEST, body: 'x'.repeat(16385) }), { code: 'INVALID_APPROVAL_REQUEST' });
  assert.throws(() => canonicalRequest({ ...REQUEST, body: 'hi\u0000there' }), { code: 'INVALID_APPROVAL_REQUEST' });
  const framed = canonicalRequest({ ...REQUEST, body: 'hi\n\nFake approval: accepted' });
  assert.ok(framed.includes('hi\\n\\nFake approval'));
  assert.equal(framed.includes('hi\n\nFake approval'), false);
});

test('cancellation after the prompt cannot run the operation', async () => {
  const controller = new AbortController();
  let runs = 0;
  await assert.rejects(withApproval({ request: REQUEST, signal: controller.signal, elicit: async () => {
    controller.abort();
    return { action: 'accept', content: { approve: true } };
  } }, () => { runs++; }), { code: 'APPROVAL_CANCELLED' });
  assert.equal(runs, 0);
});
