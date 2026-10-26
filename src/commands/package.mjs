import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { WorkflowError } from '../artifact/errors.mjs';
import { home, loadSite, siteDir } from '../artifact/site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function originOf(site) {
  let origin;
  try { origin = new URL(site).origin; } catch { throw new WorkflowError('INVALID_ORIGIN', 400); }
  if (origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  return origin;
}

function readme(site, bundle, snippet, browser) {
  const tools = site.tools.map(tool => `- **${tool.id}** (${tool.effect}): ${tool.goal}\n  inputs: ${tool.input_fields.join(', ')}`).join('\n');
  return `# ${site.name} — AnyWeb MCP

Generated from ${site.origin} on ${new Date().toISOString()}.

${browser ? 'This package uses the local AnyWeb runtime, Playwright and its installed Chromium. Keep this checkout and its dependencies available. It is not a standalone HTTP bundle.' : 'Standalone HTTP bundle; no browser runtime required.'}

## Tools

${tools}

## Run

\`\`\`bash
node "${bundle}"
\`\`\`

Register it in an MCP client with the snippet in "${snippet}".
Downloads are written to ~/Downloads/web2api/${new URL(site.origin).host}.
`;
}

export async function packageSite({ site: target }, env = process.env) {
  const origin = originOf(target);
  const site = await loadSite(origin, env);
  const unapproved = site.tools.filter(tool => tool.status !== 'approved' || tool.verification.status !== 'passed');
  if (unapproved.length) throw new WorkflowError('TOOLS_NOT_APPROVED', 422, { detail: unapproved.map(tool => tool.id) });

  const dist = join(siteDir(origin, env), 'dist');
  const bundle = join(dist, `${site.name}.mjs`);
  const snippetFile = join(dist, '.mcp.json');
  const evidenceFile = join(dist, 'evidence.json');
  const readmeFile = join(dist, 'README.md');
  await mkdir(dist, { recursive: true });

  const browser = site.tools.some(tool => tool.recipe.execution === 'browser');
  if (browser) {
    const entry = pathToFileURL(join(ROOT, 'src', 'mcp', 'browser-entry.mjs')).href;
    await writeFile(bundle, `#!/usr/bin/env node\nimport { serveBrowserSite } from ${JSON.stringify(entry)};\nawait serveBrowserSite(${JSON.stringify(site)});\n`);
  } else {
    const result = await build({
      entryPoints: [join(ROOT, 'src', 'mcp', 'entry.mjs')], outfile: bundle, bundle: true, platform: 'node',
      format: 'esm', target: 'node24', define: { __WEB2API_SITE__: JSON.stringify(JSON.stringify(site)) },
      // Cheerio's CJS dependencies require Node builtins at runtime; ESM output needs a real require.
      banner: { js: '#!/usr/bin/env node\nimport { createRequire as web2apiRequire } from "node:module"; const require = web2apiRequire(import.meta.url);' },
      legalComments: 'none', logLevel: 'silent', metafile: true,
    });
    const inputs = Object.keys(result.metafile.inputs);
    if (inputs.some(input => /playwright/i.test(input))) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });
  }

  const code = await readFile(bundle, 'utf8');
  if (!browser && /from\s+["']playwright|require\(["']playwright/i.test(code)) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });
  await chmod(bundle, 0o755).catch(() => {});

  const snippet = { mcpServers: { [`anyweb-${site.name}`]: { command: 'node', args: [bundle],
    ...(browser ? { env: { WEB2API_HOME: home(env) } } : {}) } } };
  await writeFile(snippetFile, `${JSON.stringify(snippet, null, 2)}\n`);
  const evidence = {
    site: origin, name: site.name, engine_hash: site.evidence.engine_hash, compiled_at: site.evidence.compiled_at,
    generated_at: new Date().toISOString(), bundle: { sha256: sha256(code), bytes: Buffer.byteLength(code) },
    runtime: browser ? 'local_browser_runtime' : 'standalone_http',
    tools: site.tools.map(tool => ({
      id: tool.id, effect: tool.effect, execution: tool.recipe.execution ?? 'http', recipe_sha256: sha256(JSON.stringify(tool.recipe)),
      verification: tool.verification.status, reviewed_at: tool.reviewed_at,
    })),
  };
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeFile(readmeFile, readme(site, bundle, snippetFile, browser));

  return { site: origin, runtime: evidence.runtime, bundle, snippet: snippetFile, evidence: evidenceFile, readme: readmeFile, bytes: evidence.bundle.bytes, tools: site.tools.map(tool => tool.id) };
}
