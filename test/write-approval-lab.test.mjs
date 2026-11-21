import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withApproval } from '../src/approval/elicitation.mjs';
import { startLab } from './lab/server.mjs';

// SCRIPTED CLIENT, NOT A HUMAN. The MCP client below answers elicitation from a
// fixed script. A pass proves that the server-side gate and the lab oracle agree
// under those scripted answers. It does not prove that a person saw or approved
// anything, and it is not evidence about any real account.
//
// The lab session cookie and CSRF token are injected by this harness for the
// fetch; they are not part of the request object shown to the client.
//
// It also does not prove that withApproval binds the callback to the request it
// displayed. The module displays `request` and hands the callback a snapshot;
// this experiment fetches from that snapshot, so they match here by construction,
// not by enforcement. What a callback actually sends remains a caller obligation
// and needs independent security review.

const byId = (left, right) => left.id.localeCompare(right.id);
const payloadOf = response => JSON.parse(response.content[0].text);

async function login(lab) {
  const response = await fetch(`${lab.origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(lab.credentials),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const setCookie = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie');
  return { cookie: setCookie.split(';')[0], csrf: body.csrf };
}

async function readNotes(lab, session, tag = 'work') {
  const response = await fetch(`${lab.origin}/api/notes?tag=${tag}`, { headers: { cookie: session.cookie } });
  assert.equal(response.status, 200);
  return (await response.json()).notes;
}

const createdEvents = async lab => (await lab.oracle.events()).filter(event => event.type === 'note.created');
const countFor = (events, id) => events.filter(event => event.note.id === id).length;

// A real MCP server and client over a real in-memory transport pair. The only
// scripted part is the client's answer to the elicitation prompt.
async function harness(t, lab, session, { capabilities, script = [] } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: 'write-approval-lab', version: '1.0.0' });
  const prompts = [];
  let calls = 0;

  server.registerTool('create_note', {
    description: 'Create one note in the fictional local lab. Every call asks the client to confirm again.',
    inputSchema: z.object({ id: z.string(), tag: z.string(), text: z.string() }),
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (args, ctx) => {
    calls += 1;
    // This callback sends from the snapshot withApproval passes in. That equality
    // is a property of this callback, not something withApproval enforces.
    const request = {
      method: 'POST',
      url: `${lab.origin}/api/notes`,
      body: JSON.stringify({ id: args.id, tag: args.tag, text: args.text }),
      contentType: 'application/json',
    };
    try {
      const result = await withApproval(
        { request, elicit: ctx.mcpReq.elicitInput, signal: ctx.mcpReq.signal },
        async approved => {
          const response = await fetch(approved.url, {
            method: approved.method,
            redirect: 'manual',
            headers: {
              'content-type': approved.contentType,
              cookie: session.cookie,
              'x-lab-csrf': session.csrf,
            },
            body: approved.body,
          });
          return { status: response.status, body: await response.json() };
        },
      );
      if (result.status !== 201) {
        const error = new Error('lab rejected the write');
        error.code = 'LAB_WRITE_REJECTED';
        error.status = result.status;
        error.body = result.body;
        throw error;
      }
      return { content: [{ type: 'text', text: JSON.stringify({ status: result.status, note: result.body.note, prompts: prompts.length, calls }) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: error.code, reason: error.reason, status: error.status, body: error.body, prompts: prompts.length, calls }) }],
      };
    }
  });

  const client = new Client(
    { name: 'scripted-approval-client', version: '1.0.0' },
    capabilities === undefined ? undefined : { capabilities },
  );
  if (capabilities?.elicitation) {
    client.setRequestHandler('elicitation/create', async request => {
      prompts.push(request.params);
      const answer = script.shift();
      if (!answer) throw new Error('script exhausted');
      return answer;
    });
  }

  t.after(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    prompts,
    calls: () => calls,
    call: args => client.callTool({ name: 'create_note', arguments: args }),
  };
}

test('scripted client: decline, cancel and missing elicitation capability create zero notes', async t => {
  const lab = await startLab();
  t.after(async () => {
    await lab.close();
    await rm(lab.ledgerDir, { recursive: true, force: true });
  });

  assert.equal(new URL(lab.origin).hostname, '127.0.0.1', 'the lab must stay on loopback');
  const session = await login(lab);
  assert.equal((await createdEvents(lab)).length, 0);
  const before = await readNotes(lab, session);

  const cases = [
    { label: 'decline', id: 'note-declined-1', options: { capabilities: { elicitation: {} }, script: [{ action: 'decline' }] }, code: 'APPROVAL_DECLINED', prompts: 1 },
    { label: 'cancel', id: 'note-cancelled-1', options: { capabilities: { elicitation: {} }, script: [{ action: 'cancel' }] }, code: 'APPROVAL_CANCELLED', prompts: 1 },
    { label: 'missing capability', id: 'note-no-capability-1', options: { capabilities: undefined }, code: 'APPROVAL_UNAVAILABLE', reason: 'CAPABILITY_ABSENT', prompts: 0 },
  ];

  for (const item of cases) {
    const { call, prompts } = await harness(t, lab, session, item.options);
    const response = await call({ id: item.id, tag: 'work', text: `Must not be written (${item.label})` });
    assert.equal(response.isError, true, item.label);
    const payload = payloadOf(response);
    assert.equal(payload.code, item.code, item.label);
    assert.equal(payload.reason, item.reason, item.label);
    assert.equal(payload.body, undefined, `${item.label}: the lab write must not run`);
    assert.equal(prompts.length, item.prompts, `${item.label}: prompt count`);
    assert.equal((await lab.oracle.notes()).some(note => note.id === item.id), false, `${item.label}: oracle must not contain the note`);
  }

  assert.deepEqual(await createdEvents(lab), []);
  assert.equal(
    lab.requests.filter(request => request.method === 'POST' && request.path === '/api/notes').length,
    0,
    'no unapproved POST may reach the lab',
  );
  assert.deepEqual(await readNotes(lab, session), before);
  assert.deepEqual(await lab.oracle.notes('work'), before);
  t.diagnostic('scripted client: decline=1 cancel=1 capability_absent=1 notes_created=0 post_attempts=0 human_presence=not_proven');
});

test('scripted client: an accepted call writes exactly one matching note; replay asks again and adds none', async t => {
  const lab = await startLab();
  t.after(async () => {
    await lab.close();
    await rm(lab.ledgerDir, { recursive: true, force: true });
  });

  assert.equal(new URL(lab.origin).hostname, '127.0.0.1', 'the lab must stay on loopback');
  const session = await login(lab);
  const before = await readNotes(lab, session);
  assert.equal((await createdEvents(lab)).length, 0);

  const accept = { action: 'accept', content: { approve: true } };
  const { call, prompts, calls } = await harness(t, lab, session, {
    capabilities: { elicitation: {} },
    script: [accept, accept],
  });

  const first = { id: 'note-approved-1', tag: 'work', text: 'First scripted approval' };
  const write = async note => {
    const response = await call(note);
    assert.notEqual(response.isError, true, JSON.stringify(response));
    return payloadOf(response);
  };

  const firstResult = await write(first);
  assert.equal(firstResult.status, 201);
  assert.equal(firstResult.note.id, first.id);
  assert.equal(firstResult.note.tag, first.tag);
  assert.equal(firstResult.note.text, first.text);
  assert.ok(!Number.isNaN(Date.parse(firstResult.note.created_at)));

  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].mode, 'form');
  assert.match(prompts[0].message, /^Approve exactly this request\?/);
  // Assert only what the scripted client was shown. Even with the snapshot
  // callback, withApproval cannot verify what a caller's callback sends.
  const displayed = JSON.parse(prompts[0].message.slice(prompts[0].message.indexOf('\n\n') + 2));
  assert.deepEqual(displayed, {
    method: 'POST',
    url: `${lab.origin}/api/notes`,
    body: JSON.stringify(first),
    contentType: 'application/json',
  });
  assert.deepEqual(prompts[0].requestedSchema.required, ['approve']);

  let events = await createdEvents(lab);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].note, firstResult.note);

  const afterFirst = [...before, firstResult.note].sort(byId);
  assert.deepEqual(await lab.oracle.notes('work'), afterFirst);
  assert.deepEqual(await readNotes(lab, session), afterFirst);

  // Replay the exact same request. A cached or reusable approval would skip the
  // prompt; the lab would still reject the duplicate, so the prompt count is the
  // signal that a second confirmation was actually requested.
  const replay = await call(first);
  assert.equal(replay.isError, true);
  const replayPayload = payloadOf(replay);
  assert.equal(replayPayload.code, 'LAB_WRITE_REJECTED');
  assert.equal(replayPayload.status, 409);
  assert.deepEqual(replayPayload.body, { error: 'already_exists' });
  assert.equal(prompts.length, 2, 'a second call must ask again; acceptance is not a reusable token');
  assert.equal(prompts[1].message, prompts[0].message, 'the same request was displayed again');

  events = await createdEvents(lab);
  assert.equal(events.length, 1);
  assert.equal(countFor(events, first.id), 1, 'the replay must not create a duplicate event');
  assert.deepEqual(await lab.oracle.notes('work'), afterFirst);
  assert.deepEqual(await readNotes(lab, session), afterFirst);
  assert.equal(calls(), 2);

  const secrets = [lab.credentials.email, lab.credentials.password, session.csrf, session.cookie.split('=')[1]];
  for (const prompt of prompts) {
    const shown = JSON.stringify(prompt);
    for (const secret of secrets) {
      assert.ok(!shown.includes(secret), 'elicitation must not carry a session secret');
    }
    assert.doesNotMatch(shown, /lab_sid|x-lab-csrf|cookie/i);
  }

  assert.deepEqual(
    lab.requests.filter(request => request.method === 'POST' && request.path === '/api/notes').map(request => request.status),
    [201, 409],
  );
  t.diagnostic('scripted client: accepts=2 notes_created=1 prompts=2 replay=409 fresh_get=oracle_match secrets_in_prompt=0 human_presence=not_proven');
});
