import { Hono } from 'hono';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkflowError } from '../artifact/errors.mjs';
import { loadDeclarations } from '../artifact/site.mjs';
import { extractHtml } from '../artifact/html.mjs';
import { describeLocator } from './browser-actions.mjs';
import { redact, redactUrl } from '../redact.mjs';

const MAX_SNAPSHOT = 100000;

export function createExploreApp({ page, recorder, token, site, startedAt, actions, screenshotPath, shutdown, log, guard, budget, marks }) {
  const app = new Hono();
  let requestCursor = 0, consoleCursor = 0, blockedCursor = 0;

  const drain = () => {
    const requests = recorder.since(requestCursor), console = recorder.consoleSince(consoleCursor);
    const blocked = guard.since(blockedCursor);
    requestCursor = recorder.cursor();
    consoleCursor = recorder.consoleCursor();
    blockedCursor = guard.cursor();
    return { requests, console, ...(blocked.length ? { blocked, confirmation_required: { code: 'CONFIRM_REQUIRED', nonce: blocked.at(-1).nonce } } : {}) };
  };
  const snapshotNow = async () => {
    const text = await page.ariaSnapshot({ mode: 'ai' });
    const truncated = text.length > MAX_SNAPSHOT;
    return { url: page.url(), snapshot: truncated ? text.slice(0, MAX_SNAPSHOT) : text, truncated };
  };
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {});
    // Debounced search-as-you-type calls land after the keystroke that caused them.
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(150);
  };
  const body = async c => {
    const value = await c.req.json().catch(() => null);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('INVALID_INPUT', 400);
    return value;
  };
  const action = async c => c.json({ ...(await snapshotNow()), ...drain() });

  app.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) return c.json({ error: 'UNAUTHORIZED' }, 401);
    await next();
  });
  app.onError((error, c) => {
    const status = error instanceof WorkflowError ? error.status : 500;
    if (status >= 500) log?.error({ err: error }, 'explore request failed');
    const details = Object.fromEntries(Object.entries(error).filter(([key]) => !['name', 'message', 'stack', 'code', 'status'].includes(key)));
    return c.json({ error: error.code ?? 'INTERNAL', message: error.message, ...details }, status);
  });

  app.post('/open', async c => {
    const { url } = await body(c);
    let target;
    try { target = new URL(url); } catch { throw new WorkflowError('INVALID_INPUT', 400); }
    if (typeof url !== 'string' || target.origin !== site) throw new WorkflowError('ORIGIN_REJECTED', 409);
    if (marks.open()?.execution === 'browser' && (target.username || target.password || redactUrl(target.href) !== target.href)) throw new WorkflowError('BROWSER_SECRET_INPUT', 400);
    budget.spend();
    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (marks.open()?.execution === 'browser') {
      marks.record({ action: 'open', url: target.href });
    }
    actions.count++;
    await settle();
    return action(c);
  });

  app.post('/click', async c => {
    const { ref } = await body(c);
    if (typeof ref !== 'string' || !/^[a-z][a-z0-9]*$/i.test(ref)) throw new WorkflowError('INVALID_INPUT', 400);
    budget.spend();
    const description = marks.open()?.execution === 'browser' ? await describeLocator(page.getByRef(ref)) : null;
    try { await page.getByRef(ref).click({ timeout: 5000 }); }
    catch (error) { throw new WorkflowError('STALE_REF', 409, { detail: error.message }); }
    if (description) marks.record({ action: 'click', locator: description });
    actions.count++;
    await settle();
    return action(c);
  });

  app.post('/type', async c => {
    const { ref, text, submit } = await body(c);
    if (typeof ref !== 'string' || !/^[a-z][a-z0-9]*$/i.test(ref) || typeof text !== 'string' || text.length > 10000) throw new WorkflowError('INVALID_INPUT', 400);
    budget.spend();
    const description = marks.open()?.execution === 'browser' ? await describeLocator(page.getByRef(ref)) : null;
    try {
      const locator = page.getByRef(ref);
      // fill() only fires `input`; SPAs usually listen for keyup/keydown.
      await locator.fill('', { timeout: 5000 });
      await locator.pressSequentially(text, { timeout: 15000, delay: 5 });
      // Typing can detach the field (suggestion dropdowns re-render it); Enter goes to whatever has focus.
      if (submit) await page.keyboard.press('Enter');
    } catch (error) { throw new WorkflowError('STALE_REF', 409, { detail: error.message }); }
    if (description) marks.record({ action: 'type', locator: description, text, submit: !!submit });
    actions.count++;
    await settle();
    return action(c);
  });

  app.post('/press', async c => {
    const { key } = await body(c);
    if (typeof key !== 'string' || key.length > 50) throw new WorkflowError('INVALID_INPUT', 400);
    budget.spend();
    await page.keyboard.press(key);
    marks.record({ action: 'press', key });
    actions.count++;
    await settle();
    return action(c);
  });

  app.get('/snapshot', async c => c.json(await snapshotNow()));

  app.get('/requests', c => {
    const since = Number.parseInt(c.req.query('since') ?? '0', 10);
    if (!Number.isInteger(since) || since < 0) throw new WorkflowError('INVALID_INPUT', 400);
    return c.json({ cursor: recorder.cursor(), requests: recorder.since(since) });
  });

  // Raw documents stay out of /requests and /marks; only propose fetches them by id.
  app.get('/documents/:id', c => {
    const html = recorder.document(c.req.param('id'));
    if (typeof html !== 'string') throw new WorkflowError('DOCUMENT_NOT_FOUND', 404);
    return c.json({ id: c.req.param('id'), html });
  });

  app.get('/screenshot', async c => {
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return c.json({ path: screenshotPath });
  });

  app.post('/confirm', async c => {
    const { nonce } = await body(c);
    if (typeof nonce !== 'string' || !/^[a-f0-9]{16}$/.test(nonce)) throw new WorkflowError('INVALID_INPUT', 400);
    const entry = guard.confirm(nonce);
    return c.json({ confirmed: true, request: { method: entry.method, url: entry.url } });
  });

  app.post('/mark', async c => {
    const { phase, tool, input, role } = await body(c);
    if (phase === 'begin') {
      let declaration;
      try { declaration = (await loadDeclarations(site)).tools.find(candidate => candidate.id === tool); }
      catch (error) { if (error.code !== 'SITE_NOT_FOUND') throw error; }
      return c.json(marks.begin({ tool, input, role, execution: declaration?.execution, extract: declaration?.extract }));
    }
    if (phase === 'end') {
      await settle();
      const open = marks.open();
      const output = open?.execution === 'browser' ? redact(extractHtml(await page.content(), page.url(), open.extract)) : undefined;
      return c.json(marks.end(output));
    }
    if (phase === 'reset') return c.json(marks.reset());
    throw new WorkflowError('INVALID_INPUT', 400);
  });

  app.get('/marks', c => c.json({ marks: marks.list(), open: marks.open() }));

  app.get('/status', c => c.json({
    pid: process.pid, site, url: page.url(), started_at: startedAt, actions: actions.count, requests: recorder.size(),
    budget: budget.status(), marks: marks.list().length, open_mark: marks.open(), blocked: guard.cursor(),
  }));

  app.post('/stop', c => {
    setTimeout(() => shutdown(0), 50);
    return c.json({ stopped: true });
  });

  return app;
}
