import { createHash } from 'node:crypto';
import { WorkflowError } from './errors.mjs';

// Stored in verification.hashes (a string map the site schema already allows). `verification` itself is
// mutable and excluded from the digest, so re-review can overwrite it without changing the reviewed grant.
export const REVIEW_DIGEST_KEY = 'review_digest';

const stale = (tool, reason) => new WorkflowError('REVIEW_STALE', 409, { tool: tool?.id ?? null, reason });
const malformed = () => { throw new WorkflowError('REVIEW_STALE', 409, { reason: 'malformed' }); };

// Sorted keys make the digest independent of insertion order; arrays keep theirs. Non-JSON values throw
// instead of being silently dropped or coerced, so two different tools cannot share a digest.
function canonical(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : malformed();
  if (typeof value !== 'object') malformed();
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) malformed();
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

// Only what a human approved: everything else on the tool is bookkeeping.
function material(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) malformed();
  const { id, goal, effect, input_fields: inputs, recipe, approved_requests: approved } = tool;
  if (typeof id !== 'string' || typeof goal !== 'string' || typeof effect !== 'string' || !Array.isArray(inputs) ||
      !recipe || typeof recipe !== 'object' || Array.isArray(recipe) || !Array.isArray(approved)) malformed();
  return { id, goal, effect, input_fields: inputs, recipe, approved_requests: approved };
}

export const reviewDigest = tool => createHash('sha256').update(canonical(material(tool))).digest('hex');

// Fail closed on a missing, malformed or stale grant. Returns the digest; never mutates the tool.
export function assertReviewed(tool) {
  const digest = reviewDigest(tool);
  const stored = tool.verification?.hashes?.[REVIEW_DIGEST_KEY];
  if (stored === undefined) throw stale(tool, 'missing');
  if (typeof stored !== 'string' || !/^[a-f0-9]{64}$/.test(stored)) throw stale(tool, 'malformed');
  if (stored !== digest) throw stale(tool, 'mismatch');
  return digest;
}
