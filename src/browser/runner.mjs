import { chromium } from 'playwright';
import { browserRecipeSchema, browserResultMatches } from '../artifact/browser.mjs';
import { readWorkflowInput } from '../artifact/recipe.mjs';
import { extractHtml } from '../artifact/html.mjs';
import { parse, WorkflowError } from '../artifact/errors.mjs';
import { redactUrl } from '../redact.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const resolve = (binding, input) => binding.kind === 'input' ? input[binding.field] : binding.value;
const signature = (method, url) => `${method} ${url.origin}${url.pathname}`;

export function createBrowserRunner(rawRecipe, approved, { session = null, allowLoopback = false, onStep = () => {} } = {}) {
  const recipe = parse(browserRecipeSchema, rawRecipe, 'INVALID_BROWSER_RECIPE');
  if (recipe.session && !session) throw new WorkflowError('REAUTH_REQUIRED', 401);
  if (Object.keys(session?.headers ?? {}).length) throw new WorkflowError('BROWSER_STORAGE_STATE_REQUIRED', 400);
  const allowed = new Set();
  for (const request of approved) {
    const url = new URL(request.path, request.origin);
    if (url.origin !== request.origin || url.username || url.password ||
        !(url.protocol === 'https:' || (allowLoopback && url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw new WorkflowError('ORIGIN_REJECTED', 400);
    if (request.method !== 'GET') throw new WorkflowError('BROWSER_READ_ONLY', 400);
    allowed.add(signature(request.method, url));
  }
  for (const step of recipe.steps) if (step.action === 'open' && !allowed.has(signature('GET', new URL(step.url)))) throw new WorkflowError('UNREVIEWED_OPERATION', 400);

  return async raw => {
    const input = parse(readWorkflowInput(recipe), raw);
    const browser = await chromium.launch({ headless: true, timeout: 15000 });
    let failure, index = 0;
    const timer = setTimeout(() => {
      failure ??= new WorkflowError('BROWSER_TIMEOUT', 504);
      void browser.close().catch(() => {});
    }, 30000);
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
        ...(session ? { storageState: { cookies: session.cookies ?? [], origins: session.origins ?? [] } } : {}) });
      context.setDefaultTimeout(5000);
      context.setDefaultNavigationTimeout(10000);
      const calls = [];
      let requests = 0;
      const block = code => { failure ??= new WorkflowError(code, 422); };
      await context.routeWebSocket('**/*', async socket => { block('BROWSER_WEBSOCKET_UNSUPPORTED'); await socket.close(); });
      await context.route('**/*', async route => {
        let response;
        try {
          const request = route.request(), url = new URL(request.url());
          if (failure || request.method() !== 'GET' || url.username || url.password || !allowed.has(signature(request.method(), url))) {
            block('UNREVIEWED_OPERATION');
            return await route.abort();
          }
          if (++requests > 200) { block('BUDGET_EXHAUSTED'); return await route.abort(); }
          // Chromium does not route every redirect hop. Reject redirects before the browser follows them.
          response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 });
          const status = response.status();
          calls.push({ method: request.method(), url: redactUrl(url.href), status });
          if (status >= 300 && status < 400) { block('BROWSER_REDIRECT_UNSUPPORTED'); return await route.abort(); }
          if (status === 401 || status === 403) { block('REAUTH_REQUIRED'); return await route.abort(); }
          if (status >= 400) { block('UPSTREAM_CHANGED'); return await route.abort(); }
          await route.fulfill({ response });
        } catch {
          block('UPSTREAM_UNAVAILABLE');
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
        if (step.action === 'open') await page.goto(step.url, { waitUntil: 'domcontentloaded' });
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
      if (!browserResultMatches(recipe, data, input)) throw new WorkflowError('VERIFICATION_FAILED', 422);
      return { data, evidence: { transport: 'browser', workflow: recipe.id, effect: 'read', observed_at: new Date().toISOString(),
        steps_completed: recipe.steps.length, calls, verification: recipe.checks, discovery: recipe.discovery, autonomous_discovery: false } };
    } catch (error) {
      const result = failure ?? (error instanceof WorkflowError ? error : new WorkflowError('BROWSER_STEP_FAILED', 422));
      result.step ??= Math.min(index, recipe.steps.length - 1);
      throw result;
    } finally {
      clearTimeout(timer);
      await browser.close();
    }
  };
}
