import { chromium } from 'playwright';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { compileRecipe, createRecipeRunner } from '../src/artifact/recipe.mjs';
import { createRecorder } from '../src/explore/recorder.mjs';
import { cases, verdict } from './oracle.mjs';

const origin = 'http://127.0.0.1:4331';
const started = performance.now();
const browser = await chromium.launch();
const traces = [];
try {
  for (const product_name of ['Laptop Pro', 'Laptop Air']) {
    const page = await browser.newPage();
    const recorder = createRecorder(page);
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Search products' }).fill(product_name);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/product');
    await page.getByRole('link', { name: product_name, exact: true }).click();
    await (await response).finished();
    await page.waitForFunction(() => document.querySelector('#detail')?.textContent.length > 0);
    // Recorder callbacks consume response bodies asynchronously.
    for (let i = 0; i < 100 && !recorder.since(0).some(e => new URL(e.url).pathname === '/api/product'); i++) await new Promise(r => setTimeout(r, 10));
    const calls = recorder.since(0).filter(e => e.body && new URL(e.url).pathname.startsWith('/api/')).map(e => {
      const url = new URL(e.url);
      return { origin: url.origin, path: url.pathname, method: e.method, encoding: 'query', params: Object.fromEntries(url.searchParams), status: e.status, response: e.body };
    });
    traces.push({ input: { product_name }, calls });
    await page.close();
  }
} finally { await browser.close(); }
const approved = traces[0].calls.map(({ origin, path, method }) => ({ origin, path, method, success: {} }));
const recipe = compileRecipe({ id: 'product_detail', traces, approvedRequests: approved });
const learning_ms = performance.now() - started;
const run = createRecipeRunner(recipe, approved, { allowLoopback: true });
const rows = [];
for (let repetition = 0; repetition < 5; repetition++) {
  for (const entry of cases) {
    const begin = performance.now();
    try {
      const result = await run({ product_name: entry.input });
      rows.push({ input: entry.input, repetition, ms: performance.now() - begin, requests: result.evidence.calls.length, ...verdict(entry.expected, result.data) });
    } catch (error) { rows.push({ input: entry.input, repetition, ms: performance.now() - begin, passed: false, error: error.code ?? error.message }); }
  }
}
let negative;
try { const result = await run({ product_name: 'Nonexistent Product' }); negative = { passed: false, actual: result.data }; }
catch (error) { negative = { passed: error.code === 'NO_MATCH', error: error.code }; }
// A successful, shape-compatible response can still be semantically wrong.
const originalFetch = globalThis.fetch;
let drift;
try {
  globalThis.fetch = async (url, init) => {
    const response = await originalFetch(url, init);
    const path = new URL(url).pathname;
    if (!['/api/product', '/api/products'].includes(path)) return response;
    const body = await response.json();
    const changed = path === '/api/products'
      ? { ...body, products: body.products.map(product => ({ ...product, price: product.price + 100 })) }
      : { ...body, price: body.price + 100 };
    return new Response(JSON.stringify(changed), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await run({ product_name: cases[0].input });
    drift = { runner_reported_success: true, ...verdict(cases[0].expected, result.data) };
  } catch (error) { drift = { runner_reported_success: false, error: error.code }; }
} finally { globalThis.fetch = originalFetch; }
const report = { timestamp: new Date().toISOString(), operation: 'exact product detail lookup', learning_ms, training: ['Laptop Pro', 'Laptop Air'], held_out: cases.map(c => c.input), repetitions: 5, rows, negative, drift, limitations: ['Training demonstrations scripted by developer, not autonomously discovered', 'Catalog observed during training includes held-out names; their detail requests are held out', 'No LLM cost measurement', 'Drift oracle is fixture-only ground truth, not a general production verifier'] };
await mkdir('experiments/results', { recursive: true });
await writeFile('experiments/results/learned.json', JSON.stringify(report, null, 2) + '\n');
await writeFile('experiments/results/recipe.json', JSON.stringify(recipe, null, 2) + '\n');
console.log(JSON.stringify({ learning_ms, passed: rows.filter(r => r.passed).length, total: rows.length, mean_ms: rows.reduce((sum, r) => sum + r.ms, 0) / rows.length, negative, drift }, null, 2));
if (rows.some(r => !r.passed) || !negative.passed || (drift.runner_reported_success && drift.passed !== false)) process.exitCode = 1;
