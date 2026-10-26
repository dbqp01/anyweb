import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkflowError } from './artifact/errors.mjs';
import { sessionFile } from './artifact/site.mjs';

export const sessionName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export async function readSession(origin, name, env = process.env) {
  if (!name) return null;
  let raw;
  try { raw = await readFile(sessionFile(origin, env), 'utf8'); }
  catch { throw new WorkflowError('REAUTH_REQUIRED', 401, { session: name }); }
  try { return JSON.parse(raw); }
  catch { throw new WorkflowError('REAUTH_REQUIRED', 401, { session: name }); }
}

export async function writeSession(origin, state, env = process.env) {
  const file = sessionFile(origin, env), temp = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => {});
  await rename(temp, file);
  return file;
}

export async function inspectSession(origin, env = process.env) {
  const file = sessionFile(origin, env);
  try {
    const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const state = JSON.parse(raw);
    return { exists: true, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0, updated_at: info.mtime.toISOString() };
  } catch (error) {
    return { exists: error.code !== 'ENOENT', valid: error.code === 'ENOENT' ? undefined : false };
  }
}
