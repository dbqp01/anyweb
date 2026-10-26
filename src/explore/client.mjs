import { WorkflowError } from '../artifact/errors.mjs';
import { readState } from './state.mjs';

export async function call(origin, path, { method = 'POST', body } = {}, env = process.env) {
  const state = await readState(origin, env);
  if (!state) throw new WorkflowError('DAEMON_NOT_RUNNING', 409);
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${state.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch { throw new WorkflowError('DAEMON_UNREACHABLE', 503); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new WorkflowError(payload.error || 'DAEMON_ERROR', response.status, payload);
  return payload;
}

export const open = (origin, url, env) => call(origin, '/open', { body: { url } }, env);
export const click = (origin, ref, env) => call(origin, '/click', { body: { ref } }, env);
export const type = (origin, ref, text, submit, env) => call(origin, '/type', { body: { ref, text, submit: !!submit } }, env);
export const press = (origin, key, env) => call(origin, '/press', { body: { key } }, env);
export const snapshot = (origin, env) => call(origin, '/snapshot', { method: 'GET' }, env);
export const requests = (origin, since = 0, env) => call(origin, `/requests?since=${since}`, { method: 'GET' }, env);
export const document = (origin, id, env) => call(origin, `/documents/${encodeURIComponent(id)}`, { method: 'GET' }, env);
export const screenshot = (origin, env) => call(origin, '/screenshot', { method: 'GET' }, env);
export const status = (origin, env) => call(origin, '/status', { method: 'GET' }, env);
export const stop = (origin, env) => call(origin, '/stop', {}, env);
export const mark = (origin, payload, env) => call(origin, '/mark', { body: payload }, env);
export const marks = (origin, env) => call(origin, '/marks', { method: 'GET' }, env);
export const resetMarks = (origin, env) => call(origin, '/mark', { body: { phase: 'reset' } }, env);
export const confirm = (origin, nonce, env) => call(origin, '/confirm', { body: { nonce } }, env);
