import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runFile } from '../artifact/site.mjs';

export function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function readState(origin, env = process.env) {
  let raw;
  try { raw = await readFile(runFile(origin, env), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let state;
  try { state = JSON.parse(raw); } catch { await clearState(origin, env); return null; }
  if (!state?.pid || !alive(state.pid)) { await clearState(origin, env); return null; }
  return state;
}

export async function writeState(origin, state, env = process.env) {
  const file = runFile(origin, env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

export async function clearState(origin, env = process.env) {
  await rm(runFile(origin, env), { force: true });
}
