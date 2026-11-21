import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WorkflowError } from './artifact/errors.mjs';
import { sessionFile } from './artifact/site.mjs';

export const sessionName = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);

export function scopeStorageState(origin, state) {
  const host = new URL(origin).hostname.toLowerCase();
  return {
    cookies: (state.cookies ?? []).filter(cookie => {
      if (typeof cookie.domain !== 'string') return false;
      const domain = cookie.domain.toLowerCase();
      return domain.startsWith('.') ? host === domain.slice(1) || host.endsWith(domain) : host === domain;
    }),
    origins: (state.origins ?? []).filter(entry => entry.origin === origin),
  };
}

export async function readSession(origin, name, env = process.env) {
  if (!name) return null;
  let raw;
  if (!sessionName(name)) throw new WorkflowError('INVALID_SESSION', 400);
  try { raw = await readFile(sessionFile(origin, env, name), 'utf8'); }
  catch { throw new WorkflowError('REAUTH_REQUIRED', 401, { session: name }); }
  try { return JSON.parse(raw); }
  catch { throw new WorkflowError('REAUTH_REQUIRED', 401, { session: name }); }
}

export async function writeSession(origin, state, env = process.env, name = 'default') {
  const file = sessionFile(origin, env, name), temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600).catch(() => {});
    // Windows can transiently reject simultaneous replacements of the same file.
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, file); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 20) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
  } finally {
    await rm(temp, { force: true });
  }
  return file;
}

export async function inspectSession(origin, env = process.env, name = 'default') {
  const file = sessionFile(origin, env, name);
  try {
    const [raw, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    const state = JSON.parse(raw);
    return { exists: true, cookies: state.cookies?.length ?? 0, origins: state.origins?.length ?? 0, updated_at: info.mtime.toISOString() };
  } catch (error) {
    return { exists: error.code !== 'ENOENT', valid: error.code === 'ENOENT' ? undefined : false };
  }
}
