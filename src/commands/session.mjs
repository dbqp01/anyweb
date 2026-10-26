import { createInterface } from 'node:readline/promises';
import { rm, stat } from 'node:fs/promises';
import { WorkflowError } from '../artifact/errors.mjs';
import { profileDir, sessionFile } from '../artifact/site.mjs';
import { inspectSession, sessionName, writeSession } from '../session.mjs';

const exists = path => stat(path).then(() => true, () => false);

function originOf(site) {
  let origin;
  try { origin = new URL(site).origin; } catch { throw new WorkflowError('INVALID_ORIGIN', 400); }
  if (origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  return origin;
}

export async function login({ site, session = 'default', startUrl }, env = process.env) {
  const origin = originOf(site);
  const url = startUrl ?? origin;
  if (new URL(url).origin !== origin) throw new WorkflowError('INVALID_ORIGIN', 400);
  if (!sessionName(session)) throw new WorkflowError('INVALID_SESSION', 400);
  if (!process.stdin.isTTY) throw new WorkflowError('TTY_REQUIRED', 409);

  const profile = profileDir(origin, env);
  const { chromium } = await import('playwright');
  // A persistent profile keeps IndexedDB auth (WhatsApp); storageState is still exported for HTTP replay.
  const context = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 800 } });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { await rl.question('Log in in the browser, then press Enter to save the session: '); }
    finally { rl.close(); }
    const state = await context.storageState();
    const file = await writeSession(origin, state, env);
    return { site: origin, session, file, profile, cookies: state.cookies.length, origins: state.origins.length };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function status({ site }, env = process.env) {
  const origin = originOf(site);
  return { site: origin, ...(await inspectSession(origin, env)), profile: await exists(profileDir(origin, env)) };
}

export async function clear({ site }, env = process.env) {
  const origin = originOf(site);
  const profile = profileDir(origin, env);
  const existed = (await inspectSession(origin, env)).exists;
  const hadProfile = await exists(profile);
  if (existed) await rm(sessionFile(origin, env), { force: true });
  if (hadProfile) await rm(profile, { recursive: true, force: true });
  return { site: origin, cleared: existed, profile_cleared: hadProfile };
}
