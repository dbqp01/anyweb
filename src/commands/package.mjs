import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { WorkflowError } from '../artifact/errors.mjs';
import { assertReviewed } from '../artifact/review-integrity.mjs';
import { writeNotices } from '../artifact/licenses.mjs';
import { buildListing } from '../artifact/listing.mjs';
import { home, loadSite, siteDir } from '../artifact/site.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function originOf(site) {
  let origin;
  try { origin = new URL(site).origin; } catch { throw new WorkflowError('INVALID_ORIGIN', 400); }
  if (origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  return origin;
}

function readme(site, bundle, snippet, browser, notices) {
  const tools = site.tools.map(tool => `- **${tool.id}** (${tool.effect}): ${tool.goal}\n  inputs: ${tool.input_fields.join(', ')}`).join('\n');
  return `# ${site.name} — AnyWeb MCP

Generated from ${site.origin} on ${new Date().toISOString()}.

${browser ? 'This package uses the local AnyWeb runtime, Playwright and its installed Chromium. Keep the AnyWeb installation and its dependencies available and run `npx playwright install chromium` once. It is not a standalone HTTP bundle.' : 'Standalone HTTP bundle; no browser runtime required.'}

Third-party license texts for the dependencies bundled into the server are in "${notices}".

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
  for (const tool of site.tools) assertReviewed(tool);

  const dist = join(siteDir(origin, env), 'dist');
  const bundle = join(dist, `${site.name}.mjs`);
  const snippetFile = join(dist, '.mcp.json');
  const evidenceFile = join(dist, 'evidence.json');
  const readmeFile = join(dist, 'README.md');
  const noticesFile = join(dist, 'THIRD_PARTY_NOTICES.txt');
  const listingFile = join(dist, 'listing.json');
  await mkdir(dist, { recursive: true });

  const browser = site.tools.some(tool => tool.recipe.execution === 'browser');
  const bundleOptions = {
    bundle: true, platform: 'node', format: 'esm', target: 'node24', absWorkingDir: ROOT,
    // Cheerio's CJS dependencies require Node builtins at runtime; ESM output needs a real require.
    banner: { js: '#!/usr/bin/env node\nimport { createRequire as web2apiRequire } from "node:module"; const require = web2apiRequire(import.meta.url);' },
    legalComments: 'eof', logLevel: 'silent', metafile: true,
  };
  let result;
  if (browser) {
    // Resolve once from the installed CLI so the bundle does not depend on WEB2API_HOME or the checkout; fall back
    // to a bare specifier when Playwright is absent. The proxy keeps the import lazy so the failure is coded.
    let playwright = 'playwright';
    try { playwright = import.meta.resolve('playwright'); } catch {}
    const lazyPlaywright = {
      name: 'lazy-playwright',
      setup(context) {
        context.onResolve({ filter: /^playwright$/ }, args => args.kind === 'dynamic-import'
          ? { path: 'playwright', external: true }
          : { path: 'playwright', namespace: 'anyweb-lazy' });
        context.onLoad({ filter: /.*/, namespace: 'anyweb-lazy' }, () => ({
          contents: `import { WorkflowError } from ${JSON.stringify(join(ROOT, 'src', 'artifact', 'errors.mjs'))};
const entry = ${JSON.stringify(playwright)};
export const chromium = new Proxy({}, { get: (_, method) => (...args) => import(entry)
  .then(module => module.chromium[method](...args), () => { throw new WorkflowError('PLAYWRIGHT_REQUIRED', 501); }) });`,
          resolveDir: ROOT,
        }));
      },
    };
    result = await build({
      ...bundleOptions, outfile: bundle, plugins: [lazyPlaywright],
      stdin: { contents: `import { serveBrowserSite } from './src/mcp/browser-entry.mjs';\nawait serveBrowserSite(${JSON.stringify(site)});`, resolveDir: ROOT, sourcefile: 'anyweb-browser.mjs', loader: 'js' },
    });
  } else {
    result = await build({
      ...bundleOptions, entryPoints: [join(ROOT, 'src', 'mcp', 'entry.mjs')], outfile: bundle,
      define: { __WEB2API_SITE__: JSON.stringify(JSON.stringify(site)) },
    });
    const inputs = Object.keys(result.metafile.inputs);
    if (inputs.some(input => /playwright/i.test(input))) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });
  }

  const code = await readFile(bundle, 'utf8');
  if (!browser && /from\s+["']playwright|require\(["']playwright/i.test(code)) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });
  if (browser && !code.includes('PLAYWRIGHT_REQUIRED')) throw new WorkflowError('BUNDLE_INVALID', 500, { detail: 'playwright' });
  await chmod(bundle, 0o755).catch(() => {});
  const notices = await writeNotices({ file: noticesFile, inputs: Object.keys(result.metafile.inputs), root: ROOT, bundle });

  const snippet = { mcpServers: { [`anyweb-${site.name}`]: { command: process.execPath, args: [bundle],
    env: { WEB2API_HOME: home(env) } } } };
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
  const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(evidenceFile, evidenceText);
  // A missing or unreadable listing only means no publisher fields yet.
  const previous = await readFile(listingFile, 'utf8').then(JSON.parse, () => null);
  await writeFile(listingFile, `${JSON.stringify(buildListing({ site, evidence, evidenceText, previous }), null, 2)}\n`);
  await writeFile(readmeFile, readme(site, bundle, snippetFile, browser, notices));

  return { site: origin, runtime: evidence.runtime, bundle, snippet: snippetFile, evidence: evidenceFile, listing: listingFile, readme: readmeFile, notices, bytes: evidence.bundle.bytes, tools: site.tools.map(tool => tool.id) };
}
