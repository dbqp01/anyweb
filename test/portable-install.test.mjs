import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { compileRecipe } from '../src/artifact/recipe.mjs';
import { compileBrowserRecipe } from '../src/artifact/browser.mjs';
import { loadSite, saveSite } from '../src/artifact/site.mjs';
import { reviewDigest, REVIEW_DIGEST_KEY } from '../src/artifact/review-integrity.mjs';
import { startFixture, products } from './fixtures/server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Windows Node here cannot spawn bare git from PATH, and npm needs git for Baileys' git dependency.
const git = process.platform === 'win32' ? join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git', 'cmd', 'git.exe') : undefined;
const npmEnv = {
  ...process.env,
  ...(git && existsSync(git) ? { npm_config_git: git } : {}),
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  npm_config_ignore_scripts: 'true',
};
const cleanEnv = extra => Object.fromEntries(Object.entries({ ...extra }).filter(([, value]) => value !== undefined));
async function approveFixture(origin, env) {
  const site = await loadSite(origin, env);
  for (const tool of site.tools) tool.verification.hashes[REVIEW_DIGEST_KEY] = reviewDigest(tool);
  await saveSite(site, env);
}

test('npm pack installs a portable CLI that builds and serves MCP servers without the checkout', { timeout: 420000 }, async t => {
  const fixture = await startFixture();
  const temp = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'anyweb-portable-'));
  const packDir = join(temp, 'pack');
  const app = join(temp, 'app');
  const httpHome = join(app, 'http-home');
  const browserHome = join(app, 'browser-home');
  const downloads = join(app, 'downloads');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(packDir, { recursive: true });
  await mkdir(app, { recursive: true });
  t.after(async () => {
    await fixture.close();
    await rm(temp, { recursive: true, force: true });
  });

  const packed = await execa(npm, ['pack', '--json', '--pack-destination', packDir], { cwd: ROOT, env: npmEnv, reject: false, timeout: 120000 });
  assert.equal(packed.exitCode, 0, packed.stderr);
  const manifest = JSON.parse(packed.stdout)[0];
  const files = manifest.files.map(file => file.path);
  for (const required of ['package.json', 'README.md', 'AGENTS.md', 'skills/anyweb/SKILL.md', 'skills/anyweb/references/security.md', 'docs/method.md', 'examples/product-lookup.json', 'src/cli.mjs', 'src/commands/package.mjs', 'src/mcp/browser-entry.mjs']) {
    assert.ok(files.includes(required), `${required} must ship in the tarball`);
  }
  for (const forbidden of ['test/', 'experiments/', '.local/', '.env', 'docs/plan/', 'docs/evidence/']) {
    assert.equal(files.some(file => file === forbidden || file.startsWith(forbidden)), false, `${forbidden} must not ship in the tarball`);
  }

  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'anyweb-portable-probe', private: true, type: 'module' }));
  const installed = await execa(npm, ['install', join(packDir, manifest.filename), '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], {
    cwd: app, env: npmEnv, reject: false, timeout: 240000,
  });
  assert.equal(installed.exitCode, 0, installed.stderr);

  const pkgRoot = join(app, 'node_modules', 'anyweb-mcp');
  const installedManifest = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'));
  assert.deepEqual(installedManifest.bin, { anyweb: 'src/cli.mjs', web2api: 'src/cli.mjs' });
  assert.ok(existsSync(join(pkgRoot, 'src', 'cli.mjs')), 'cli must exist in the isolated install');
  const installedRequire = createRequire(join(pkgRoot, 'package.json'));
  assert.ok(existsSync(installedRequire.resolve('esbuild')), 'esbuild must be a runtime dependency');
  assert.ok(existsSync(installedRequire.resolve('playwright')), 'playwright must be installed for the browser runtime');
  assert.ok(existsSync(installedRequire.resolve('@modelcontextprotocol/client')), 'the bundled MCP probe must have its client dependency');

  const bin = process.platform === 'win32' ? join(app, 'node_modules', '.bin', 'anyweb.cmd') : join(app, 'node_modules', '.bin', 'anyweb');
  assert.ok(existsSync(bin), 'npm must link the anyweb executable');
  const version = await execa(bin, ['--version'], { cwd: app, env: cleanEnv({ ...process.env, WEB2API_HOME: httpHome }), reject: false });
  assert.equal(version.exitCode, 0, version.stderr);
  assert.match(version.stdout, /1\.0\.0/);

  const detail = name => products.find(product => product.name === name);
  const readTraces = ['Laptop Pro', 'Laptop Air'].map(product_name => ({
    input: { product_name },
    calls: [
      { origin: fixture.origin, path: '/api/products', method: 'GET', encoding: 'query', params: { q: product_name }, status: 200, response: { products } },
      { origin: fixture.origin, path: '/api/product', method: 'GET', encoding: 'query', params: { id: detail(product_name).id }, status: 200, response: detail(product_name) },
    ],
  }));
  const approvedRequests = [
    { origin: fixture.origin, path: '/api/products', method: 'GET', success: {} },
    { origin: fixture.origin, path: '/api/product', method: 'GET', success: {} },
  ];
  await saveSite({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'portable', created_at: new Date().toISOString(), session: null,
    tools: [{
      id: 'portable_detail', goal: 'Look up a product by exact name', effect: 'read', status: 'approved', input_fields: ['product_name'],
      approved_requests: approvedRequests, recipe: compileRecipe({ id: 'portable_detail', traces: readTraces, approvedRequests }),
      verification: { status: 'passed', training: 2, held_out: 1, hashes: {} }, reviewed_at: new Date().toISOString(),
    }],
    evidence: { actions: 8, requests_observed: 10, compiled_at: new Date().toISOString(), engine_hash: 'c'.repeat(64) },
  }, { WEB2API_HOME: httpHome });
  await approveFixture(fixture.origin, { WEB2API_HOME: httpHome });

  const httpCli = cleanEnv({ ...process.env, WEB2API_HOME: httpHome });
  const packagedHttp = await execa(bin, ['package', '--site', fixture.origin, '--json'], { cwd: app, env: httpCli, reject: false });
  assert.equal(packagedHttp.exitCode, 0, `${packagedHttp.stdout}\n${packagedHttp.stderr}`);
  const httpPayload = JSON.parse(packagedHttp.stdout);
  assert.equal(httpPayload.runtime, 'standalone_http');
  assert.equal(httpPayload.bundle.startsWith(httpHome), true, 'bundle must live outside the checkout');
  const httpCode = await readFile(httpPayload.bundle, 'utf8');
  assert.equal(httpCode.includes(ROOT), false, 'the HTTP bundle must not reference the checkout');
  assert.equal(httpCode.includes('browser-entry.mjs'), false);
  assert.deepEqual(JSON.parse(await readFile(httpPayload.snippet, 'utf8')).mcpServers['anyweb-portable'], { command: process.execPath, args: [httpPayload.bundle], env: { WEB2API_HOME: httpHome } });

  const httpClient = new Client({ name: 'portable-http', version: '1.0.0' });
  t.after(() => httpClient.close().catch(() => {}));
  await httpClient.connect(new StdioClientTransport({ command: process.execPath, args: [httpPayload.bundle],
    env: cleanEnv({ ...process.env, WEB2API_HOME: httpHome, WEB2API_DOWNLOADS: downloads }), stderr: 'pipe' }));
  const listed = await httpClient.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ['portable_detail']);
  const read = await httpClient.callTool({ name: 'portable_detail', arguments: { product_name: 'Phone Max' } });
  assert.ok(!read.isError, JSON.stringify(read));
  const body = JSON.parse(read.content[0].text);
  assert.equal(body.data.name, 'Phone Max');
  assert.equal(body.evidence.steps_completed, 2);
  const probe = await execa(process.execPath, [join(pkgRoot, 'skills', 'anyweb', 'scripts', 'mcp-probe.mjs'), httpPayload.bundle, 'portable_detail', JSON.stringify({ product_name: 'Phone Max' })], {
    cwd: app, env: cleanEnv({ ...process.env, WEB2API_HOME: httpHome, WEB2API_DOWNLOADS: downloads }), reject: false, timeout: 60000,
  });
  assert.equal(probe.exitCode, 0, probe.stderr);
  const probeData = JSON.parse(probe.stdout);
  assert.equal(probeData.tools[0].name, 'portable_detail');
  assert.equal(JSON.parse(probeData.call.content[0].text).data.name, 'Phone Max');

  const extract = { mode: 'object', root: '#browser-detail', fields: { id: { attr: 'data-id' }, name: { selector: 'h1' }, price: { selector: '.price' } } };
  const browserMarks = ['Laptop Pro', 'Laptop Air'].map((product_name, index) => ({
    input: { product_name },
    browser_actions: [
      { action: 'open', url: `${fixture.origin}/browser` },
      { action: 'type', locator: { kind: 'role', role: 'textbox', name: 'Product' }, text: product_name, submit: false },
      { action: 'click', locator: { kind: 'role', role: 'button', name: 'Search' } },
      { action: 'click', locator: { kind: 'role', role: 'button', name: product_name } },
    ],
    browser_output: index === 0 ? { id: 'p1', name: 'Laptop Pro', price: '1200' } : { id: 'p2', name: 'Laptop Air', price: '900' },
  }));
  await saveSite({
    version: 1, origin: fixture.origin, allowed_origins: [], name: 'portable-browser', created_at: new Date().toISOString(), session: null,
    tools: [{
      id: 'portable_browser_detail', goal: 'Read a product rendered by JavaScript', effect: 'read', status: 'approved', input_fields: ['product_name'],
      approved_requests: [{ origin: fixture.origin, path: '/browser', method: 'GET', success: {} }],
      recipe: compileBrowserRecipe({ id: 'portable_browser_detail', input_fields: ['product_name'], session: null, extract, marks: browserMarks }),
      verification: { status: 'passed', training: 2, held_out: 1, hashes: {} }, reviewed_at: new Date().toISOString(),
    }],
    evidence: { actions: 8, requests_observed: 4, compiled_at: new Date().toISOString(), engine_hash: 'd'.repeat(64) },
  }, { WEB2API_HOME: browserHome });
  await approveFixture(fixture.origin, { WEB2API_HOME: browserHome });

  const packagedBrowser = await execa(bin, ['package', '--site', fixture.origin, '--json'], { cwd: app, env: cleanEnv({ ...process.env, WEB2API_HOME: browserHome }), reject: false });
  assert.equal(packagedBrowser.exitCode, 0, `${packagedBrowser.stdout}\n${packagedBrowser.stderr}`);
  const browserPayload = JSON.parse(packagedBrowser.stdout);
  assert.equal(browserPayload.runtime, 'local_browser_runtime');
  const browserCode = await readFile(browserPayload.bundle, 'utf8');
  assert.equal(browserCode.includes(ROOT), false, 'the browser bundle must not reference the checkout');
  assert.equal(/from\s+["'][^"']*browser-entry\.mjs/.test(browserCode), false, 'the browser bundle must not import the source entry by path');
  assert.match(browserCode, /PLAYWRIGHT_REQUIRED/);
  assert.match(await readFile(browserPayload.readme, 'utf8'), /Playwright/);
  assert.match(await readFile(browserPayload.readme, 'utf8'), /not a standalone HTTP bundle/);

  const browserClient = new Client({ name: 'portable-browser', version: '1.0.0' });
  t.after(() => browserClient.close().catch(() => {}));
  await browserClient.connect(new StdioClientTransport({ command: process.execPath, args: [browserPayload.bundle],
    env: cleanEnv({ ...process.env, WEB2API_HOME: browserHome }), stderr: 'pipe' }));
  const result = await browserClient.callTool({ name: 'portable_browser_detail', arguments: { product_name: 'Tablet Mini' } });
  assert.ok(!result.isError, JSON.stringify(result));
  const browserBody = JSON.parse(result.content[0].text);
  assert.deepEqual(browserBody.data, { id: 'p4', name: 'Tablet Mini', price: '350' });
  assert.equal(browserBody.evidence.transport, 'browser');
});
