import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { home } from '../../artifact/site.mjs';

export const authDir = (env = process.env, explicit) =>
  explicit || env.WEB2API_WHATSAPP_AUTH || join(home(env), 'connectors', 'whatsapp', 'auth');
export const storeFile = dir => join(dir, 'store.json');
export const authAvailable = dir => existsSync(join(dir, 'creds.json'));

export async function ensureAuthDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

// Baileys writes creds with the default umask; the paired-device keys are secrets.
export async function harden(dir) {
  await chmod(dir, 0o700).catch(() => {});
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await harden(path);
    else await chmod(path, 0o600).catch(() => {});
  }
}
