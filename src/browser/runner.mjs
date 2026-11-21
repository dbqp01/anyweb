import { chromium } from 'playwright';
import { browserRecipeSchema, browserResultMatches } from '../artifact/browser.mjs';
import { readPolicySchema, readWorkflowInput } from '../artifact/recipe.mjs';
import { extractHtml } from '../artifact/html.mjs';
import { parse, WorkflowError } from '../artifact/errors.mjs';
import { redactUrl } from '../redact.mjs';
import { isChallenge } from '../net/challenge.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const resolve = (binding, input) => binding.kind === 'input' ? input[binding.field] : binding.value;
const signature = (method, url) => `${method} ${url.origin}${url.pathname}`;
// Bound values replace whole query entries, so demo values cannot add or shadow parameters.
const openUrl = (step, input) => {
  const url = new URL(step.url);
  for (const binding of step.query ?? []) url.searchParams.set(binding.name, resolve(binding, input));
  return url;
};
// A request may only repeat the reviewed query exactly: same names, literals equal, and
// input rules equal to the declared input. Everything else stays unreviewed.
const queryAllowed = (policy, url, input) => {
  const rules = new Map(policy.query.map(rule => [rule.name, rule])), entries = [...url.searchParams];
  return new Set(entries.map(([name]) => name)).size === entries.length && entries.length === rules.size &&
    entries.every(([name, value]) => {
      const rule = rules.get(name);
      return rule?.kind === 'literal' ? rule.value === value : rule?.kind === 'input' && input[rule.field] === value;
    });
};
// Steps are reviewed before launch: neither a static value nor a binding may invent a query.
const stepReviewed = (policy, step) => {
  const rules = new Map(policy.query.map(rule => [rule.name, rule]));
  const params = [...new URL(step.url).searchParams], bindings = step.query ?? [];
  const names = [...params.map(([name]) => name), ...bindings.map(binding => binding.name)];
  return new Set(names).size === names.length && names.length === rules.size &&
    params.every(([name, value]) => rules.get(name)?.kind === 'literal' && rules.get(name).value === value) &&
    bindings.every(binding => rules.get(binding.name)?.kind === 'input' && rules.get(binding.name).field === binding.field);
};

export function createBrowserRunner(rawRecipe, approved, { session = null, allowLoopback = false, onStep = () => {} } = {}) {
  const recipe = parse(browserRecipeSchema, rawRecipe, 'INVALID_BROWSER_RECIPE');
  if (recipe.session && !session) throw new WorkflowError('REAUTH_REQUIRED', 401);
  if (Object.keys(session?.headers ?? {}).length) throw new WorkflowError('BROWSER_STORAGE_STATE_REQUIRED', 400);
  const allowed = new Map();
  for (const request of approved) {
    const url = new URL(request.path, request.origin);
    if (url.origin !== request.origin || url.username || url.password ||
        !(url.protocol === 'https:' || (allowLoopback && url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw new WorkflowError('ORIGIN_REJECTED', 400);
    if (request.method !== 'GET') throw new WorkflowError('BROWSER_READ_ONLY', 400);
    // Legacy approvals carry no query policy; they parse to an empty one and fail closed.
    let policy;
    try { policy = parse(readPolicySchema, request, 'UNREVIEWED_QUERY'); }
    catch { throw new WorkflowError('UNREVIEWED_QUERY', 400); }
    if (policy.query.some(rule => rule.kind === 'input' && !recipe.input_fields.includes(rule.field))) throw new WorkflowError('UNREVIEWED_QUERY', 400);
    allowed.set(signature('GET', url), policy);
  }
  for (const step of recipe.steps) if (step.action === 'open') {
    const policy = allowed.get(signature('GET', new URL(step.url)));
    if (!policy) throw new WorkflowError('UNREVIEWED_OPERATION', 400);
    if (!stepReviewed(policy, step)) throw new WorkflowError('UNREVIEWED_QUERY', 400);
  }

  // Playwright's own Chromium first; when that build is missing (a newer Playwright than the downloaded browsers),
  // fall back to the Chrome or Edge already installed on the machine instead of failing.
  async function launch() {
    for (const channel of [undefined, 'chrome', 'msedge']) {
      try { return await chromium.launch({ headless: true, timeout: 15000, ...(channel ? { channel } : {}) }); }
      catch (error) {
        if (error instanceof WorkflowError) throw error; // PLAYWRIGHT_REQUIRED from the packaged lazy import
        const absent = /Executable doesn't exist|playwright install|is not found|not installed/i.test(error?.message ?? '');
        if (!absent) throw new WorkflowError('BROWSER_LAUNCH_FAILED', 503, { transient: true });
      }
    }
    throw new WorkflowError('BROWSER_NOT_INSTALLED', 503, {
      instruction: 'No usable browser: the Chromium build this AnyWeb installation expects is missing and neither Chrome nor Edge is installed. Ask the person to run "npx playwright install chromium" next to the AnyWeb installation, then call this tool again.',
    });
  }

  // The workflow only reads, so a run that died from a crash, a failed launch or a network blip is safe to repeat once.
  return async raw => {
    const input = parse(readWorkflowInput(recipe), raw);
    try { return await runOnce(input); }
    catch (error) {
      if (!error.transient) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
      return await runOnce(input);
    }
  };

  async function runOnce(input) {
    let browser;
    browser = await launch();
    let failure, index = 0, closing = false;
    const fail = error => { failure ??= error; };
    browser.on('disconnected', () => { if (!closing) fail(new WorkflowError('BROWSER_CRASHED', 503, { transient: true })); });
    const timer = setTimeout(() => {
      fail(new WorkflowError('BROWSER_TIMEOUT', 504));
      closing = true;
      void browser.close().catch(() => {});
    }, 30000);
    const challenged = async page => {
      if (isChallenge({ html: await page.content().catch(() => '') })) fail(new WorkflowError('CHALLENGE_REQUIRED', 403, { site: new URL(page.url()).origin }));
    };
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
        ...(session ? { storageState: { cookies: session.cookies ?? [], origins: session.origins ?? [] } } : {}) });
      context.setDefaultTimeout(5000);
      context.setDefaultNavigationTimeout(10000);
      const calls = [];
      let requests = 0;
      const block = code => fail(new WorkflowError(code, 422));
      await context.routeWebSocket('**/*', async socket => { block('BROWSER_WEBSOCKET_UNSUPPORTED'); await socket.close(); });
      await context.route('**/*', async route => {
        let response;
        try {
          const request = route.request(), url = new URL(request.url()), policy = allowed.get(signature(request.method(), url));
          if (failure || !policy || url.username || url.password) {
            block('UNREVIEWED_OPERATION');
            return await route.abort();
          }
          if (!queryAllowed(policy, url, input)) {
            block('UNREVIEWED_QUERY');
            return await route.abort();
          }
          if (++requests > 200) { block('BUDGET_EXHAUSTED'); return await route.abort(); }
          // Chromium does not route every redirect hop. Reject redirects before the browser follows them.
          response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 });
          const status = response.status();
          calls.push({ method: request.method(), url: redactUrl(url.href), status });
          if (status >= 300 && status < 400) { block('BROWSER_REDIRECT_UNSUPPORTED'); return await route.abort(); }
          if (status >= 400 && isChallenge({ status, headers: new Headers(response.headers()), html: await response.text().catch(() => '') })) {
            fail(new WorkflowError('CHALLENGE_REQUIRED', 403, { site: url.origin }));
            return await route.abort();
          }
          if (status === 401 || status === 403) { block('REAUTH_REQUIRED'); return await route.abort(); }
          if (status === 429 || status >= 500) { fail(new WorkflowError('UPSTREAM_UNAVAILABLE', 502, { transient: true })); return await route.abort(); }
          if (status >= 400) { block('UPSTREAM_CHANGED'); return await route.abort(); }
          await route.fulfill({ response });
        } catch {
          fail(new WorkflowError('UPSTREAM_UNAVAILABLE', 502, { transient: true }));
          await route.abort().catch(() => {});
        } finally { await response?.dispose().catch(() => {}); }
      });
      const page = await context.newPage();
      context.on('page', popup => { if (popup !== page) { block('BROWSER_POPUP_UNSUPPORTED'); void popup.close().catch(() => {}); } });
      page.on('dialog', dialog => { block('BROWSER_DIALOG_UNSUPPORTED'); void dialog.dismiss().catch(() => {}); });
      page.on('download', download => { block('BROWSER_READ_ONLY'); void download.cancel().catch(() => {}); });
      const target = spec => spec.kind === 'css' ? page.locator(spec.value)
        : spec.kind === 'label' ? page.getByLabel(resolve(spec.name, input), { exact: true })
          : page.getByRole(spec.role, { name: resolve(spec.name, input), exact: true });
      for (; index < recipe.steps.length; index++) {
        if (failure) throw failure;
        const step = recipe.steps[index];
        if (step.action === 'open') {
          const url = openUrl(step, input), policy = allowed.get(signature('GET', url));
          if (!policy) throw new WorkflowError('UNREVIEWED_OPERATION', 400);
          if (!queryAllowed(policy, url, input)) throw new WorkflowError('UNREVIEWED_QUERY', 400);
          await page.goto(url.href, { waitUntil: 'domcontentloaded' });
          await challenged(page);
        }
        else if (step.action === 'press') await page.keyboard.press(step.key);
        else {
          const locator = target(step.locator);
          if (await locator.count() > 1) throw new WorkflowError('AMBIGUOUS_BROWSER_TARGET', 422);
          await locator.waitFor({ state: 'visible' });
          if (await locator.count() !== 1) throw new WorkflowError('AMBIGUOUS_BROWSER_TARGET', 422);
          if (step.action === 'click') await locator.click();
          else {
            if (await locator.getAttribute('type') === 'password') throw new WorkflowError('BROWSER_SECRET_INPUT', 400);
            await locator.fill('');
            await locator.pressSequentially(resolve(step.text, input), { delay: 5 });
            if (step.submit) await locator.press('Enter');
          }
        }
        if (failure) throw failure;
        onStep({ step: index, action: step.action, url: redactUrl(page.url()) });
      }
      let data;
      const deadline = Date.now() + 5000;
      do {
        if (failure) throw failure;
        if (recipe.extract.mode === 'object' && await page.locator(recipe.extract.root).count() > 1) throw new WorkflowError('AMBIGUOUS_BROWSER_RESULT', 422);
        data = extractHtml(await page.content(), page.url(), recipe.extract);
        if (browserResultMatches(recipe, data, input)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      if (failure) throw failure;
      if (!browserResultMatches(recipe, data, input)) {
        // A challenge injected after load explains the miss better than VERIFICATION_FAILED.
        await challenged(page);
        throw failure ?? new WorkflowError('VERIFICATION_FAILED', 422);
      }
      return { data, evidence: { transport: 'browser', workflow: recipe.id, effect: 'read', observed_at: new Date().toISOString(),
        steps_completed: recipe.steps.length, calls, verification: recipe.checks, discovery: recipe.discovery, autonomous_discovery: false } };
    } catch (error) {
      const result = failure ?? (error instanceof WorkflowError ? error : new WorkflowError('BROWSER_STEP_FAILED', 422));
      result.step ??= Math.min(index, recipe.steps.length - 1);
      throw result;
    } finally {
      clearTimeout(timer);
      closing = true;
      await browser.close().catch(() => {});
    }
  }
}
