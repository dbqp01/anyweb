import { randomBytes } from 'node:crypto';
import { WorkflowError } from '../artifact/errors.mjs';
import { redactUrl } from '../redact.mjs';

const SAFE_METHODS = new Set(['GET']);
const DESTRUCTIVE = /delete|remove|send|submit|pay|buy|logout|close|unsubscribe|revoke/i;

function destructiveUrl(value) {
  const url = new URL(value);
  return DESTRUCTIVE.test(url.pathname) || [...url.searchParams].some(([key, input]) =>
    ['action', 'op', 'cmd', 'command', 'method', 'do'].includes(key.toLowerCase()) && DESTRUCTIVE.test(input));
}

export function createGuard(context) {
  const pending = [];
  context.route('**/*', async route => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    if (SAFE_METHODS.has(method) && !destructiveUrl(url)) {
      await route.continue().catch(() => {});
      return;
    }
    pending.push({ nonce: randomBytes(8).toString('hex'), method, url: redactUrl(url), at: Date.now() });
    if (pending.length > 100) pending.splice(0, pending.length - 100);
    await route.abort('blockedbyclient').catch(() => {});
  });
  return {
    since: cursor => pending.slice(Math.max(0, cursor)).map(({ nonce, method, url, at }) => ({ nonce, method, url, at })),
    cursor: () => pending.length,
    confirm(nonce) {
      const index = pending.findIndex(entry => entry.nonce === nonce);
      if (index < 0) throw new WorkflowError('UNKNOWN_NONCE', 404);
      // shortcut: no trusted human approval channel yet; add one before enabling writes.
      throw new WorkflowError('HUMAN_APPROVAL_UNAVAILABLE', 409);
    },
  };
}
