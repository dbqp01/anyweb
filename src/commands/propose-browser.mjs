import { isDeepStrictEqual } from 'node:util';
import { compileBrowserRecipe } from '../artifact/browser.mjs';
import { createBrowserRunner } from '../browser/runner.mjs';
import { WorkflowError } from '../artifact/errors.mjs';

export async function proposeBrowser(tool, ordered, draft, session) {
  const train = ordered.filter(mark => mark.role === 'train');
  const recipe = compileBrowserRecipe({ ...tool, session: draft.session, marks: train });
  const allowedOrigins = new Set([draft.origin, ...draft.allowed_origins]);
  const approved = [];
  for (const mark of train) for (const request of mark.requests) {
    const url = new URL(request.url);
    if (!allowedOrigins.has(url.origin)) throw new WorkflowError('ORIGIN_NOT_ALLOWED', 422, { tool: tool.id, origin: url.origin });
    if (request.method !== 'GET') throw new WorkflowError('BROWSER_READ_ONLY', 422, { tool: tool.id });
    if (!approved.some(item => item.origin === url.origin && item.path === url.pathname)) {
      approved.push({ origin: url.origin, path: url.pathname, method: 'GET', allow_json_text: false, success: {} });
    }
  }
  if (!approved.length || approved.length > 128) throw new WorkflowError('UNSUPPORTED_OPERATION', 422, { tool: tool.id });
  const run = createBrowserRunner(recipe, approved, { session, allowLoopback: ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(draft.origin).hostname) });
  for (const mark of ordered) {
    try {
      const result = await run(mark.input);
      if (!isDeepStrictEqual(result.data, mark.browser_output)) throw new WorkflowError('VERIFICATION_FAILED', 422);
    } catch (error) {
      if (error instanceof WorkflowError) { error.tool ??= tool.id; error.role ??= mark.role; }
      throw error;
    }
  }
  return { recipe, approved };
}
