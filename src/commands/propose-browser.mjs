import { isDeepStrictEqual } from 'node:util';
import { compileBrowserRecipe } from '../artifact/browser.mjs';
import { createBrowserRunner } from '../browser/runner.mjs';
import { WorkflowError } from '../artifact/errors.mjs';
import { isSensitiveKey } from '../redact.mjs';

const fail = (code, details) => { throw new WorkflowError(code, 422, details); };

// Query policies come from training observations only. Eval marks run under the same
// policy, so a demonstration that adds a parameter can never widen what reaches upstream.
function inferPolicy(observations, inputFields, tool) {
  const names = observations.map(({ url }) => [...url.searchParams.keys()]);
  if (names.some(keys => new Set(keys).size !== keys.length) ||
      names.some(keys => keys.length !== names[0].length || names[0].some(name => !keys.includes(name)))) {
    fail('UNREVIEWED_QUERY', { tool });
  }
  return names[0].map(name => {
    if (isSensitiveKey(name)) fail('SECRET_IN_RECIPE', { tool });
    const values = observations.map(({ url }) => url.searchParams.get(name));
    if (values.every(value => value === values[0])) return { kind: 'literal', name, value: values[0] };
    const bound = inputFields.filter(field => observations.every(({ input }, index) => input[field] === values[index]));
    if (bound.length !== 1) fail('UNBOUND_BROWSER_VALUE', { tool });
    return { kind: 'input', name, field: bound[0] };
  });
}

export async function proposeBrowser(tool, ordered, draft, session) {
  const train = ordered.filter(mark => mark.role === 'train');
  const recipe = compileBrowserRecipe({ ...tool, session: draft.session, marks: train });
  const allowedOrigins = new Set([draft.origin, ...draft.allowed_origins]);
  const observed = new Map();
  for (const mark of train) for (const request of mark.requests) {
    const url = new URL(request.url);
    if (!allowedOrigins.has(url.origin)) throw new WorkflowError('ORIGIN_NOT_ALLOWED', 422, { tool: tool.id, origin: url.origin });
    if (request.method !== 'GET') throw new WorkflowError('BROWSER_READ_ONLY', 422, { tool: tool.id });
    const key = `${url.origin}${url.pathname}`;
    if (!observed.has(key)) observed.set(key, { url, observations: [] });
    observed.get(key).observations.push({ url, input: mark.input });
  }
  const approved = [...observed.values()].map(({ url, observations }) => ({
    origin: url.origin, path: url.pathname, method: 'GET', allow_json_text: false, success: {},
    query: inferPolicy(observations, tool.input_fields, tool.id),
  }));
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
