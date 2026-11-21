import { WorkflowError } from '../artifact/errors.mjs';
import { createHash } from 'node:crypto';

// Elicitation only asks the MCP client to show a prompt. The protocol carries no
// proof that a human saw it: a scripted or malicious client, and any process
// running as the same OS user, can answer accept/approve without any UI. This
// module gates only the call sites that use it; it does not make writes safe
// against a compromised client or a same-OS agent. Per the MCP spec, form mode
// must not be used to request secrets, so callers must keep credentials out of
// the canonical text. On the SDK's 2026-07-28 era the push elicitation call
// throws; this module then fails closed rather than assuming approval.
const METHOD = /^[A-Z][A-Z0-9_-]{0,15}$/;

function invalid() {
  throw new WorkflowError('INVALID_APPROVAL_REQUEST', 400);
}

// Snapshot once before waiting. Callers must execute this snapshot, never rebuild
// from mutable input; the callback itself cannot be forced to honour that contract.
function snapshotRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) invalid();
  if (Object.keys(request).some(key => !['method', 'url', 'body', 'contentType'].includes(key))) invalid();
  const { method, url, body, contentType } = request;
  if (typeof method !== 'string' || !METHOD.test(method)) invalid();
  if (typeof url !== 'string' || url.length > 4096) invalid();
  let target;
  try {
    target = new URL(url);
  } catch {
    invalid();
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') invalid();
  if (target.username || target.password) invalid();
  target.hash = '';
  if (body !== undefined && (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 16384 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(body))) invalid();
  if (body !== undefined && (typeof contentType !== 'string' || !/^[\x20-\x7e]{1,200}$/.test(contentType))) invalid();
  if (body === undefined && contentType !== undefined) invalid();
  return Object.freeze({ method, url: target.href, ...(body === undefined ? {} : { body, contentType }) });
}

// JSON escaping prevents request text from visually impersonating prompt framing.
export const canonicalRequest = request => JSON.stringify(snapshotRequest(request), null, 2);

// Runs `run` only after the client returns accept with approve: true, for this
// one call. Nothing is cached and no approval token is returned.
export async function withApproval(options = {}, run) {
  const { request, elicit, signal } = options ?? {};
  const snapshot = snapshotRequest(request);
  const canonical = JSON.stringify(snapshot, null, 2);
  const digest = createHash('sha256').update(canonical).digest('hex');
  if (typeof run !== 'function') invalid();
  if (signal?.aborted) throw new WorkflowError('APPROVAL_CANCELLED', 409);
  if (typeof elicit !== 'function') {
    throw new WorkflowError('APPROVAL_UNAVAILABLE', 409, { reason: 'NO_ELICITATION' });
  }

  let result;
  try {
    result = await elicit({
      mode: 'form',
      message: `Approve exactly this request? It runs once, now; nothing is saved or reused.\nSHA-256: ${digest}\n\n${canonical}`,
      requestedSchema: {
        type: 'object',
        properties: {
          approve: {
            type: 'boolean',
            title: 'Approve this exact request',
            description: 'Runs only this request, once. No standing permission is granted.',
          },
        },
        required: ['approve'],
      },
    }, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) throw new WorkflowError('APPROVAL_CANCELLED', 409);
    throw new WorkflowError('APPROVAL_UNAVAILABLE', 409, {
      reason: error?.code === 'CAPABILITY_NOT_SUPPORTED' ? 'CAPABILITY_ABSENT' : 'ELICITATION_FAILED',
    });
  }

  if (signal?.aborted) throw new WorkflowError('APPROVAL_CANCELLED', 409);
  if (result?.action === 'decline') throw new WorkflowError('APPROVAL_DECLINED', 409);
  if (result?.action === 'cancel') throw new WorkflowError('APPROVAL_CANCELLED', 409);
  if (result?.action !== 'accept') {
    throw new WorkflowError('APPROVAL_UNAVAILABLE', 409, { reason: 'MALFORMED_RESPONSE' });
  }
  if (result.content?.approve !== true) throw new WorkflowError('APPROVAL_NOT_CONFIRMED', 409);

  return run(snapshot);
}
