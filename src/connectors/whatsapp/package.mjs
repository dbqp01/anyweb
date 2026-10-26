import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WorkflowError } from '../../artifact/errors.mjs';
import { home } from '../../artifact/site.mjs';
import { authAvailable, authDir as resolveAuthDir } from './auth.mjs';
import { limits, whatsappDefinitions } from './runner.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function packageWhatsApp({ authDir }, env = process.env) {
  const dir = resolveAuthDir(env, authDir);
  const dist = join(home(env), 'connectors', 'whatsapp', 'dist');
  const bundle = join(dist, 'anyweb-whatsapp.mjs');
  const snippetFile = join(dist, '.mcp.json');
  const evidenceFile = join(dist, 'evidence.json');
  const readmeFile = join(dist, 'README.md');
  await mkdir(dist, { recursive: true });

  const result = await build({
    entryPoints: [join(ROOT, 'src', 'connectors', 'whatsapp', 'entry.mjs')],
    outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    // Baileys' libsignal is CJS and requires Node builtins at runtime; ESM output needs a real require.
    banner: { js: '#!/usr/bin/env node\nimport { createRequire as web2apiRequire } from "node:module"; const require = web2apiRequire(import.meta.url);' },
    legalComments: 'none', logLevel: 'silent', metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some(input => /playwright/i.test(input))) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });

  const code = await readFile(bundle, 'utf8');
  if (/from\s+["']playwright|require\(["']playwright/i.test(code)) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });
  await chmod(bundle, 0o755).catch(() => {});

  const snippetEnv = { WEB2API_WHATSAPP_AUTH: dir };
  if (env.WEB2API_HOME) snippetEnv.WEB2API_HOME = env.WEB2API_HOME;
  const snippet = { mcpServers: { 'anyweb-whatsapp': { command: 'node', args: [bundle], env: snippetEnv } } };
  await writeFile(snippetFile, `${JSON.stringify(snippet, null, 2)}\n`);

  const tools = Object.keys(whatsappDefinitions);
  const evidence = {
    connector: 'whatsapp', transport: 'whatsapp_multidevice_websocket', read_only: true,
    auth_dir: dir, auth: authAvailable(dir), generated_at: new Date().toISOString(),
    bundle: { sha256: sha256(code), bytes: Buffer.byteLength(code) }, tools, limits,
  };
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(readmeFile, `# WhatsApp — AnyWeb MCP

Read-only connector to the user's own paired WhatsApp account. It never sends messages or presence updates and does not download media.
Unofficial multi-device protocol: use at your own risk; account restriction is possible.

Tools: ${tools.join(', ')}.

Pair a device first:

\`\`\`bash
anyweb whatsapp login
\`\`\`

Run the server:

\`\`\`bash
node "${bundle}"
\`\`\`

Register it with the snippet in "${snippetFile}". Auth lives in "${dir}".
`);
  return { auth_dir: dir, auth: authAvailable(dir), bundle, snippet: snippetFile, evidence: evidenceFile, readme: readmeFile, bytes: evidence.bundle.bytes, tools };
}
