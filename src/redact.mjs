const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const MAX_DEPTH = 100;

// Split `apiKey`, `api_key`, `X-Api-Key` and friends into lowercase words so matching
// does not depend on one exact spelling.
function keyParts(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part.toLowerCase());
}

const SECRET_PARTS = new Set([
  'token', 'tokens', 'cookie', 'cookies', 'secret', 'secrets', 'password', 'passwords',
  'passwd', 'passphrase', 'pwd', 'authorization', 'authorisation', 'auth', 'jwt',
  'session', 'sessions', 'sessionid', 'csrf', 'xsrf', 'apikey', 'credential',
  'credentials', 'bearer', 'privatekey', 'secretkey', 'accesskey', 'clientsecret',
]);

// `key` alone is too broad (keyboard, monkey, primaryKey), so it only counts when a
// qualifier makes it a known credential name.
const KEY_QUALIFIERS = new Set([
  'api', 'access', 'secret', 'private', 'client', 'signing', 'subscription', 'license',
  'session', 'auth',
]);

// Names that do not survive the word split but are unambiguous session/API credentials.
const COMPACT_SECRETS = new Set([
  'apikey', 'xapikey', 'phpsessid', 'jsessionid', 'connectsid', 'sesskey',
]);

export function isSensitiveKey(key) {
  const parts = keyParts(key);
  if (!parts.length) return false;
  const compact = parts.join('');
  if (COMPACT_SECRETS.has(compact)) return true;
  const words = parts.map(part => part.replace(/\d+$/, ''));
  if (words.some(part => SECRET_PARTS.has(part))) return true;
  return words.includes('key') && words.some(part => KEY_QUALIFIERS.has(part));
}

export function redact(value) {
  return redactValue(value, new WeakSet(), 0);
}

function redactValue(value, ancestors, depth) {
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (ancestors.has(value)) return CIRCULAR;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof URL) return redactUrl(value.href);
  if (value instanceof Map) {
    ancestors.add(value);
    try { return [...value].map(([key, child]) => [redactValue(key, ancestors, depth + 1), typeof key === 'string' && isSensitiveKey(key) ? REDACTED : redactValue(child, ancestors, depth + 1)]); }
    finally { ancestors.delete(value); }
  }
  if (value instanceof Set) {
    ancestors.add(value);
    try { return [...value].map(child => redactValue(child, ancestors, depth + 1)); }
    finally { ancestors.delete(value); }
  }
  if (ArrayBuffer.isView(value)) return value;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map(child => redactValue(child, ancestors, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, isSensitiveKey(key) ? REDACTED : redactValue(child, ancestors, depth + 1),
    ]));
  } finally {
    ancestors.delete(value);
  }
}

function isPublicTokenFlag(key, value) {
  // `token=0` is a public embed flag; longer token-like values stay redacted.
  return key.toLowerCase() === 'token' && /^[0-9]{1,2}$/.test(value);
}

function redactParams(params) {
  for (const key of new Set(params.keys())) {
    if (!isSensitiveKey(key)) continue;
    if (params.getAll(key).every(value => isPublicTokenFlag(key, value))) continue;
    params.set(key, REDACTED);
  }
}

function redactRawQuery(query) {
  return query.split('&').map(pair => {
    const equals = pair.indexOf('=');
    if (equals === -1) return pair;
    const rawKey = pair.slice(0, equals);
    const key = decodePart(rawKey);
    if (!isSensitiveKey(key) || isPublicTokenFlag(key, decodePart(pair.slice(equals + 1)))) return pair;
    return `${rawKey}=${encodeURIComponent(REDACTED)}`;
  }).join('&');
}

function redactHash(hash) {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body) return hash;
  if (body.startsWith('/')) {
    const question = body.indexOf('?');
    if (question === -1) return hash;
    const query = redactRawQuery(body.slice(question + 1));
    return query === body.slice(question + 1) ? hash : `#${body.slice(0, question + 1)}${query}`;
  }
  if (!body.includes('=')) return hash;
  const params = new URLSearchParams(body);
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (!isSensitiveKey(key)) continue;
    if (params.getAll(key).every(value => isPublicTokenFlag(key, value))) continue;
    params.set(key, REDACTED);
    changed = true;
  }
  return changed ? `#${params.toString()}` : hash;
}

function decodePart(value) {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); } catch { return value; }
}

// Relative or malformed URLs are not accepted by `new URL`; scrub their query and
// fragment textually instead of returning a possibly secret-bearing string untouched.
function redactLooseUrl(value) {
  if (typeof value !== 'string') return value;
  let output = value;
  const hashAt = output.indexOf('#');
  const question = output.indexOf('?');
  if (question !== -1 && (hashAt === -1 || question < hashAt)) {
    const end = hashAt === -1 ? output.length : hashAt;
    output = `${output.slice(0, question + 1)}${redactRawQuery(output.slice(question + 1, end))}${output.slice(end)}`;
  }
  const hash = output.indexOf('#');
  if (hash !== -1) {
    const fragment = output.slice(hash);
    const redacted = redactHash(fragment);
    if (redacted !== fragment) output = `${output.slice(0, hash)}${redacted}`;
  }
  return output;
}

export function redactUrl(value) {
  if (value instanceof URL) value = value.href;
  else if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    redactParams(url.searchParams);
    if (url.hash) {
      const hash = redactHash(url.hash);
      if (hash !== url.hash) url.hash = hash;
    }
    return url.href;
  } catch {
    return redactLooseUrl(value);
  }
}
