import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from '../../artifact/site.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export async function packageTemu(env = process.env) {
  const dir = join(home(env), 'connectors', 'temu');
  const snippet = join(dir, '.mcp.json');
  const entry = join(root, 'src', 'connectors', 'temu', 'entry.mjs');
  await mkdir(dir, { recursive: true });
  const config = { mcpServers: { 'anyweb-temu': { command: process.execPath, args: [entry] } } };
  await writeFile(snippet, `${JSON.stringify(config, null, 2)}\n`);
  return { server: 'anyweb-temu', snippet, entry };
}
