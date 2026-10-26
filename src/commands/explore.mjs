import { execa } from 'execa';
import { closeSync, openSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileDir, runLog } from '../artifact/site.mjs';
import { WorkflowError } from '../artifact/errors.mjs';
import { readState, clearState } from '../explore/state.mjs';
import * as client from '../explore/client.mjs';
import { readSession, sessionName } from '../session.mjs';

const daemonPath = fileURLToPath(new URL('../explore/daemon.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function originOf(site) {
  let origin;
  try { origin = new URL(site).origin; } catch { throw new WorkflowError('INVALID_ORIGIN', 400); }
  if (origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  return origin;
}

export async function start({ site, startUrl, headed, session, budgetActions, budgetMinutes }) {
  const origin = originOf(site);
  if (new URL(startUrl).origin !== origin) throw new WorkflowError('INVALID_ORIGIN', 400);
  if (session && !sessionName(session)) throw new WorkflowError('INVALID_SESSION', 400);
  const profile = session ? profileDir(origin, process.env) : null;
  const hasProfile = profile ? await stat(profile).then(() => true, () => false) : false;
  if (session && !hasProfile) await readSession(origin, session);
  if (await readState(origin)) throw new WorkflowError('DAEMON_ALREADY_RUNNING', 409);
  const log = runLog(origin);
  await mkdir(dirname(log), { recursive: true });
  const fd = openSync(log, 'a');
  const env = { ...process.env, WEB2API_SITE: origin, WEB2API_START_URL: startUrl, WEB2API_HEADED: headed ? '1' : '0' };
  if (session && hasProfile) env.WEB2API_PROFILE = profile;
  else if (session) env.WEB2API_SESSION = session;
  if (budgetActions) env.WEB2API_BUDGET_ACTIONS = String(budgetActions);
  if (budgetMinutes) env.WEB2API_BUDGET_MINUTES = String(budgetMinutes);
  const child = execa(process.execPath, [daemonPath], { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env });
  closeSync(fd);
  child.catch(() => {});
  child.nodeChildProcess.unref();
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = await readState(origin);
    if (state) return { site: origin, pid: state.pid, port: state.port, url: state.url };
    await delay(250);
  }
  throw new WorkflowError('DAEMON_START_TIMEOUT', 504);
}

export async function open({ site, url }) {
  const origin = originOf(site);
  let target;
  try { target = new URL(url); } catch { throw new WorkflowError('INVALID_INPUT', 400); }
  if (target.origin !== origin) throw new WorkflowError('INVALID_ORIGIN', 400);
  try { return await client.open(origin, url); }
  catch (error) {
    if (error.code !== 'DAEMON_NOT_RUNNING') throw error;
    // The agent may skip `explore start`; open is a safe place to boot the daemon.
    try { await start({ site: origin, startUrl: url }); }
    catch (failure) { if (failure.code !== 'DAEMON_ALREADY_RUNNING') throw failure; }
    return client.open(origin, url);
  }
}

export async function click({ site, ref }) {
  return client.click(originOf(site), ref);
}

export async function type({ site, ref, text, submit }) {
  return client.type(originOf(site), ref, text, submit);
}

export async function press({ site, key }) {
  return client.press(originOf(site), key);
}

export async function snapshot({ site, grep }) {
  const result = await client.snapshot(originOf(site));
  if (!grep) return result;
  let pattern;
  try { pattern = new RegExp(grep, 'i'); } catch { throw new WorkflowError('INVALID_INPUT', 400); }
  const lines = result.snapshot.split('\n').filter(line => pattern.test(line));
  return { ...result, snapshot: lines.join('\n'), matched: lines.length };
}

export async function requests({ site, since }) {
  const cursor = Number.parseInt(since ?? '0', 10);
  if (!Number.isInteger(cursor) || cursor < 0) throw new WorkflowError('INVALID_INPUT', 400);
  return client.requests(originOf(site), cursor);
}

export async function screenshot({ site }) {
  return client.screenshot(originOf(site));
}

export async function status({ site }) {
  return client.status(originOf(site));
}

export async function mark({ site, phase = 'begin', tool, input, role }) {
  const origin = originOf(site);
  if (phase === 'end') return client.mark(origin, { phase: 'end' });
  if (phase !== 'begin') throw new WorkflowError('INVALID_INPUT', 400);
  if (typeof tool !== 'string' || typeof input !== 'string' || !['train', 'eval'].includes(role)) throw new WorkflowError('INVALID_INPUT', 400);
  let parsed;
  try { parsed = JSON.parse(input); } catch { throw new WorkflowError('INVALID_INPUT', 400); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorkflowError('INVALID_INPUT', 400);
  return client.mark(origin, { phase: 'begin', tool, input: parsed, role });
}

export async function marks({ site, reset }) {
  const origin = originOf(site);
  return reset ? client.resetMarks(origin) : client.marks(origin);
}

export async function confirm({ site, nonce }) {
  return client.confirm(originOf(site), nonce);
}

export async function stop({ site, force }) {
  const origin = originOf(site);
  const state = await readState(origin);
  if (!state) return { stopped: false, note: 'not running' };
  try { await client.stop(origin); } catch (error) { if (!force) throw error; }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await readState(origin))) return { stopped: true };
    await delay(250);
  }
  if (force) {
    try { process.kill(state.pid); } catch { /* already gone */ }
    await clearState(origin);
    return { stopped: true, forced: true };
  }
  throw new WorkflowError('DAEMON_STOP_TIMEOUT', 504);
}
