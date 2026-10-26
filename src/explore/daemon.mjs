import { chromium } from 'playwright';
import { createAdaptorServer } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { home, siteKey } from '../artifact/site.mjs';
import { clearState, readState, writeState } from './state.mjs';
import { createRecorder } from './recorder.mjs';
import { createExploreApp } from './server.mjs';
import { createGuard } from './guard.mjs';
import { createBudget } from './budget.mjs';
import { createMarks } from './marks.mjs';
import { createLogger } from '../log.mjs';
import { readSession } from '../session.mjs';

const log = createLogger('explore');
const site = process.env.WEB2API_SITE;
const startUrl = process.env.WEB2API_START_URL;
const headed = process.env.WEB2API_HEADED === '1';

if (!site || !startUrl) {
  log.error('WEB2API_SITE and WEB2API_START_URL are required');
  process.exit(1);
}

let origin;
try {
  origin = new URL(site).origin;
  if (origin !== site || new URL(startUrl).origin !== origin) throw new Error('origin mismatch');
} catch {
  log.error('site and start URL must share one bare origin');
  process.exit(1);
}

const token = randomBytes(32).toString('hex');
const startedAt = new Date().toISOString();
let browser, server, shuttingDown = false;

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('explore daemon stopping');
  // A busy page can make Playwright's close hang; the daemon still has to release its state file.
  await Promise.race([browser?.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (server?.listening) await Promise.race([new Promise(resolve => server.close(resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
  try {
    const state = await readState(origin);
    if (!state || state.pid === process.pid) await clearState(origin);
  } catch { /* best effort */ }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('unhandledRejection', error => {
  log.error({ err: error }, 'unhandled rejection');
  void shutdown(1);
});

try {
  const profile = process.env.WEB2API_PROFILE;
  const session = !profile && process.env.WEB2API_SESSION ? await readSession(origin, process.env.WEB2API_SESSION) : null;
  if (profile) {
    browser = await chromium.launchPersistentContext(profile, { headless: !headed, viewport: { width: 1280, height: 800 } });
    browser.on('close', () => { if (!shuttingDown) void shutdown(0); });
  } else {
    browser = await chromium.launch({ headless: !headed });
    browser.on('disconnected', () => { if (!shuttingDown) void shutdown(0); });
  }
  const context = profile ? browser : await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(session ? { storageState: session } : {}) });
  const guard = createGuard(context);
  const page = context.pages()[0] ?? await context.newPage();
  const recorder = createRecorder(page, { site: origin });
  const actions = { count: 0 };
  const number = value => { const parsed = Number.parseInt(value ?? '', 10); return Number.isInteger(parsed) && parsed >= 0 ? parsed : Infinity; };
  const budget = createBudget({ maxActions: number(process.env.WEB2API_BUDGET_ACTIONS), maxMinutes: number(process.env.WEB2API_BUDGET_MINUTES) });
  const marks = createMarks(recorder, actions);
  const app = createExploreApp({
    page, recorder, token, site: origin, startedAt, actions, guard, budget, marks,
    screenshotPath: join(home(), 'run', `${siteKey(origin)}.png`),
    shutdown: code => void shutdown(code), log,
  });
  server = createAdaptorServer({ fetch: app.fetch });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (new URL(page.url()).origin !== origin) throw new Error('start URL left the site origin');
  const { port } = server.address();
  await writeState(origin, { pid: process.pid, port, token, url: page.url(), started_at: startedAt });
  log.info({ port }, 'explore daemon ready');
} catch (error) {
  log.error({ err: error }, 'explore daemon failed to start');
  await browser?.close().catch(() => {});
  await clearState(origin).catch(() => {});
  process.exit(1);
}
