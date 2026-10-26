import { randomBytes } from 'node:crypto';
import { WorkflowError } from '../artifact/errors.mjs';
import { redactUrl } from '../redact.mjs';

const SAFE_METHODS = new Set(['GET', 'POST']);
const DESTRUCTIVE = /delete|remove|send|submit|pay|buy|logout/i;

export function createGuard(context) {
  const pending = [], allowed = new Map();
  context.route('**/*', async route => {
    const request = route.request();
    const method = request.method();
    const url = request.url();
    const postData = request.postData() ?? '';
    if (SAFE_METHODS.has(method) && !DESTRUCTIVE.test(`${url} ${postData}`)) {
      await route.continue().catch(() => {});
      return;
    }
    const signature = `${method} ${url} ${postData}`;
    const remaining = allowed.get(signature) ?? 0;
    if (remaining > 0) {
      if (remaining === 1) allowed.delete(signature); else allowed.set(signature, remaining - 1);
      await route.continue().catch(() => {});
      return;
    }
    pending.push({ nonce: randomBytes(8).toString('hex'), method, url: redactUrl(url), signature, at: Date.now() });
    if (pending.length > 100) pending.splice(0, pending.length - 100);
    await route.abort('blockedbyclient').catch(() => {});
  });
  return {
    since: cursor => pending.slice(Math.max(0, cursor)).map(({ nonce, method, url, at }) => ({ nonce, method, url, at })),
    cursor: () => pending.length,
    confirm(nonce) {
      const index = pending.findIndex(entry => entry.nonce === nonce);
      if (index < 0) throw new WorkflowError('UNKNOWN_NONCE', 404);
      const [entry] = pending.splice(index, 1);
      allowed.set(entry.signature, 1);
      return entry;
    },
  };
}
