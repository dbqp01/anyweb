import { createServer } from 'node:http';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const SEED = [
  { id: 'note-a1', tag: 'work', text: 'Quarterly plan draft', created_at: '2026-01-05T09:00:00.000Z' },
  { id: 'note-a2', tag: 'work', text: 'Hiring loop notes', created_at: '2026-01-06T09:00:00.000Z' },
  { id: 'note-b1', tag: 'home', text: 'Weekend groceries', created_at: '2026-01-07T09:00:00.000Z' },
  { id: 'note-b2', tag: 'home', text: 'Plumber quote', created_at: '2026-01-08T09:00:00.000Z' },
  { id: 'note-c1', tag: 'archive', text: 'Retrospective from the old project', created_at: '2026-01-09T09:00:00.000Z' },
];
const TAG = /^[a-z0-9-]{1,20}$/;
const ID = /^note-[a-z0-9-]{1,32}$/;
const MAX_BODY = 16 * 1024;
const SESSION_MS = 30 * 60 * 1000;
const byId = (left, right) => left.id.localeCompare(right.id);

const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Lab sign in</title></head><body>
<main><h1>Authenticated lab</h1><p>All accounts and notes here are fictional. Credentials are printed by the test runner.</p>
<form method="post" action="/login">
<label>Email <input name="email" type="email" autocomplete="username" required></label>
<label>Password <input name="password" type="password" autocomplete="current-password" required></label>
<button>Sign in</button></form></main></body></html>`;

const APP_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Lab notes</title></head><body>
<main><h1>Lab notes</h1><p>Fictional data. <a href="/login">Sign in</a></p>
<p id="status">Loading…</p><ul id="notes"></ul></main>
<script>
const tag = new URLSearchParams(location.search).get('tag') ?? 'work';
fetch('/api/notes?tag=' + encodeURIComponent(tag)).then(async response => {
  const status = document.querySelector('#status');
  if (!response.ok) { status.textContent = 'Sign in required (' + response.status + ')'; return; }
  const { notes } = await response.json();
  status.textContent = notes.length + ' notes tagged ' + tag;
  for (const note of notes) {
    const item = document.createElement('li');
    item.dataset.id = note.id;
    item.textContent = note.text;
    document.querySelector('#notes').append(item);
  }
}).catch(() => { document.querySelector('#status').textContent = 'Load failed'; });
</script></body></html>`;

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, html, status = 200) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(html);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startLab() {
  const ledgerDir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-lab-'));
  const ledgerPath = join(ledgerDir, 'ledger.jsonl');
  const credentials = { email: 'lab.user@example.invalid', password: `lab-${randomBytes(12).toString('base64url')}` };
  const user = { email: credentials.email, name: 'Lab User' };
  const notes = new Map(SEED.map(note => [note.id, note]));
  const sessions = new Map();
  const pendingWrites = new Set();
  const requests = [];

  let queue = Promise.resolve();
  const appendEvent = event => {
    queue = queue.then(() => appendFile(ledgerPath, `${JSON.stringify(event)}\n`));
    return queue;
  };
  await writeFile(ledgerPath, [...SEED.map(note => ({ type: 'note.seeded', note }))]
    .map(event => `${JSON.stringify(event)}\n`).join(''));

  const createSession = () => {
    const sid = randomBytes(24).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    sessions.set(sid, { user, csrf, expires: Date.now() + SESSION_MS });
    return { sid, csrf };
  };

  const authenticate = request => {
    const header = request.headers.cookie ?? '';
    const sid = header.split(';').map(part => part.trim()).find(part => part.startsWith('lab_sid='))?.slice(8);
    const session = sid ? sessions.get(sid) : null;
    if (!session) return null;
    if (session.expires <= Date.now()) {
      sessions.delete(sid);
      return null;
    }
    return session;
  };

  const handleLogin = async (request, response) => {
    const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const raw = await readBody(request);
    let fields = null;
    if (type === 'application/json') {
      try { fields = JSON.parse(raw); } catch { fields = null; }
    } else if (type === 'application/x-www-form-urlencoded') fields = Object.fromEntries(new URLSearchParams(raw));
    if (!fields || typeof fields.email !== 'string' || typeof fields.password !== 'string') {
      return sendJson(response, 400, { error: 'invalid_request' });
    }
    if (fields.email.trim().toLowerCase() !== credentials.email || fields.password !== credentials.password) {
      return sendJson(response, 401, { error: 'invalid_credentials' });
    }
    const { sid, csrf } = createSession();
    const cookie = `lab_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
    if (type === 'application/x-www-form-urlencoded') {
      response.writeHead(303, { location: '/app', 'set-cookie': cookie, 'cache-control': 'no-store' });
      return response.end();
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'set-cookie': cookie, 'cache-control': 'no-store' });
    response.end(JSON.stringify({ user, csrf }));
  };

  const handleNotes = async (request, response, url, state) => {
    const session = authenticate(request);
    if (!session) return sendJson(response, 401, { error: 'unauthorized' });
    state.authenticated = true;

    if (request.method === 'GET') {
      const tag = url.searchParams.get('tag');
      if (tag !== null && !TAG.test(tag)) return sendJson(response, 400, { error: 'invalid_tag' });
      const rows = [...notes.values()].filter(note => tag === null || note.tag === tag).sort(byId);
      return sendJson(response, 200, { notes: rows });
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' });
      return response.end();
    }
    if (request.headers['x-lab-csrf'] !== session.csrf) return sendJson(response, 403, { error: 'csrf_required' });
    if ((request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
      return sendJson(response, 415, { error: 'json_required' });
    }
    let body;
    try { body = JSON.parse(await readBody(request)); } catch { return sendJson(response, 400, { error: 'invalid_json' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(response, 400, { error: 'invalid_body' });
    if (Object.keys(body).some(field => !['id', 'tag', 'text'].includes(field))) return sendJson(response, 400, { error: 'unknown_field' });
    if (!ID.test(body.id ?? '') || !TAG.test(body.tag ?? '') || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 200) {
      return sendJson(response, 400, { error: 'invalid_note' });
    }
    if (notes.has(body.id) || pendingWrites.has(body.id)) return sendJson(response, 409, { error: 'already_exists' });
    const note = { id: body.id, tag: body.tag, text: body.text.trim(), created_at: new Date().toISOString() };
    pendingWrites.add(note.id);
    try {
      await appendEvent({ type: 'note.created', note });
      notes.set(note.id, note);
    } finally {
      pendingWrites.delete(note.id);
    }
    return sendJson(response, 201, { note });
  };

  const route = async (request, response, url, state) => {
    if (request.method === 'GET' && url.pathname === '/login') return sendHtml(response, LOGIN_PAGE);
    if (request.method === 'POST' && url.pathname === '/login') return handleLogin(request, response);
    if (request.method === 'GET' && url.pathname === '/app') return sendHtml(response, APP_PAGE);
    if (url.pathname === '/api/notes') return handleNotes(request, response, url, state);
    return sendJson(response, 404, { error: 'not_found' });
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://lab.invalid');
    const state = { authenticated: false };
    response.once('finish', () => {
      // Audit metadata only: bodies, cookies and CSRF tokens never enter this log.
      requests.push({ method: request.method, path: url.pathname, status: response.statusCode, authenticated: state.authenticated, at: Date.now() });
      if (requests.length > 500) requests.shift();
    });
    route(request, response, url, state).catch(error => {
      if (!response.headersSent) sendJson(response, error.status ?? 500, { error: error.code ?? 'internal_error' });
      else response.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  const events = async () => {
    try {
      return (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  };

  return {
    origin: `http://127.0.0.1:${port}`,
    credentials,
    ledgerDir,
    requests,
    oracle: {
      ledgerPath,
      events,
      notes: async tag => (await events()).map(event => event.note)
        .filter(note => note && (tag === undefined || note.tag === tag)).sort(byId),
    },
    close: () => new Promise(resolve => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}
