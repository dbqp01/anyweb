import { Agent } from 'undici';
import { WorkflowError } from '../artifact/errors.mjs';
import { isChallenge } from './challenge.mjs';

const MAX_JSON = 262144;
const MAX_HTML = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;
// Some stores send ~21 KB of headers (Hiraoka); Node's default 16 KB limit turned that into UPSTREAM_UNAVAILABLE.
const dispatcher = new Agent({ maxHeaderSize: 128 * 1024 });
// Reads are retried on transient failures only: network errors, timeouts, 429 and 5xx. Writes never are.
const ATTEMPTS = 3;
const MAX_WAIT_MS = 10000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = (code, status, details = {}) => new WorkflowError(code, status, { transient: true, ...details });

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

function cookieHeader(cookies, url) {
  return cookies.filter(cookie => {
    if (!cookie.domain || !cookie.path || (cookie.secure && url.protocol !== 'https:')) return false;
    if (cookie.expires !== -1 && !(cookie.expires > Date.now() / 1000)) return false;
    const domain = cookie.domain.toLowerCase();
    const hostMatches = domain.startsWith('.')
      ? url.hostname === domain.slice(1) || url.hostname.endsWith(domain)
      : url.hostname === domain;
    return hostMatches && (url.pathname === cookie.path ||
      (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/')));
  }).sort((a, b) => b.path.length - a.path.length).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

async function readBody(response, limit, overflow) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new WorkflowError(overflow);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks);
}

async function statusError(response, url) {
  // A challenge often hides behind 403/429/503; peek at a small HTML body, for at most 2 s, before blaming the
  // session or the site. A body that never ends must not hang the call.
  let peek = '';
  if (/text\/html|text\/plain/i.test(response.headers.get('content-type') || '')) {
    let timer;
    const read = readBody(response, 65536, 'UPSTREAM_TOO_LARGE').then(body => body.toString('utf8'), () => '');
    peek = await Promise.race([read, new Promise(resolve => { timer = setTimeout(resolve, 2000, ''); })]);
    clearTimeout(timer);
  }
  if (isChallenge({ status: response.status, headers: response.headers, html: peek })) {
    return new WorkflowError('CHALLENGE_REQUIRED', 403, { site: url.origin });
  }
  if (response.status === 401 || response.status === 403) return new WorkflowError('REAUTH_REQUIRED', 401);
  // A 429 is retried only when the site says when; guessing would make the rate limit worse.
  if (response.status === 429) {
    const retryAfter = retryAfterMs(response);
    return retryAfter === undefined ? new WorkflowError('RATE_LIMITED', 429) : transient('RATE_LIMITED', 429, { retryAfter });
  }
  if (response.status === 404) return new WorkflowError('UPSTREAM_CHANGED');
  if (response.status === 409) return new WorkflowError('UPSTREAM_CONFLICT', 409);
  if (response.status >= 500) return transient('UPSTREAM_UNAVAILABLE', 502, { retryAfter: retryAfterMs(response) });
  return new WorkflowError('UPSTREAM_UNAVAILABLE');
}

async function request(url, init, binary, limit, options = {}) {
  const method = (init.method ?? 'GET').toUpperCase();
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(url, init, binary, limit, options);
    } catch (error) {
      if (!error.transient || attempt >= ATTEMPTS || !['GET', 'HEAD'].includes(method)) throw error;
      // Honour Retry-After when the site gives one; otherwise back off 0.5 s, 1.5 s with jitter.
      const wait = error.retryAfter ?? 500 * 3 ** (attempt - 1) * (0.75 + Math.random() / 2);
      if (wait > MAX_WAIT_MS) throw error;
      await sleep(wait);
    }
  }
}

async function requestOnce(url, init, binary, limit, { redirects = 0, cookies = [], detectLoginRedirect = false, redirectAllowed = () => true } = {}) {
  try {
    let current = new URL(url);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    init = { ...init, headers: { ...init.headers } };
    for (let hop = 0; ; hop++) {
      // Some public APIs reject the default Node UA (Wikimedia answers 429).
      const headers = { 'User-Agent': 'anyweb-mcp/1.0', ...init.headers };
      if (!Object.keys(headers).some(header => header.toLowerCase() === 'cookie')) {
        const cookie = cookieHeader(cookies, current);
        if (cookie) headers.cookie = cookie;
      }
      const response = await fetch(current, { ...init, headers, redirect: 'manual', signal, dispatcher });
      try {
        const location = response.headers.get('location');
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          const next = new URL(location, current);
          if (detectLoginRedirect && /\/(?:login|signin|sign-in)(?:\/|$|\.php)/i.test(next.pathname)) throw new WorkflowError('REAUTH_REQUIRED', 401);
          // A session or a redirect must never leave the reviewed origin.
          if (hop >= redirects || next.origin !== current.origin || next.username || next.password) throw new WorkflowError('UPSTREAM_UNAVAILABLE');
          const method = (init.method ?? 'GET').toUpperCase();
          if (([301, 302].includes(response.status) && method === 'POST') || (response.status === 303 && !['GET', 'HEAD'].includes(method))) {
            init.method = 'GET';
            delete init.body;
            for (const header of Object.keys(init.headers)) {
              if (['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'].includes(header.toLowerCase())) delete init.headers[header];
            }
          }
          if (!redirectAllowed(next, (init.method ?? 'GET').toUpperCase())) throw new WorkflowError('UNREVIEWED_OPERATION', 422);
          current = next;
          continue;
        }
        if (!response.ok) throw await statusError(response, current);
        const contentType = response.headers.get('content-type') || '';
        const length = Number(response.headers.get('content-length') || 0);
        if (length > limit) throw new WorkflowError(binary ? 'DOWNLOAD_TOO_LARGE' : 'UPSTREAM_TOO_LARGE');
        const body = await readBody(response, limit, binary ? 'DOWNLOAD_TOO_LARGE' : 'UPSTREAM_TOO_LARGE');
        return { url: current.href, contentType, body };
      } finally {
        // Release redirects and rejected responses instead of waiting for GC.
        if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
      }
    }
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    // A 15 s timeout is not retried: three of them would outlast most MCP clients. Resets and refusals are.
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new WorkflowError('UPSTREAM_TIMEOUT');
    throw transient('UPSTREAM_UNAVAILABLE');
  }
}

export async function upstreamJson(url, init = {}, { allowJsonText = false, cookies = [] } = {}) {
  const { contentType, body } = await request(url, init, false, MAX_JSON, { cookies });
  if (!(contentType.includes('application/json') || (allowJsonText && (contentType.includes('text/html') || contentType.includes('text/plain'))))) {
    throw new WorkflowError('UPSTREAM_UNAVAILABLE');
  }
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new WorkflowError('UPSTREAM_CHANGED');
  }
}

export async function upstreamHtml(url, init = {}, { cookies = [], detectLoginRedirect = false, redirectAllowed } = {}) {
  const { url: finalUrl, contentType, body } = await request(url, init, false, MAX_HTML, { redirects: 3, cookies, detectLoginRedirect, redirectAllowed });
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type !== 'text/html' && type !== 'application/xhtml+xml') throw new WorkflowError('UPSTREAM_UNAVAILABLE');
  const html = body.toString('utf8');
  // Some WAFs answer 200 with an interstitial; extracting from it would only report VERIFICATION_FAILED.
  if (isChallenge({ html })) throw new WorkflowError('CHALLENGE_REQUIRED', 403, { site: new URL(finalUrl).origin });
  return { html, url: finalUrl };
}

export async function upstreamBinary(url, init = {}, { maxBytes = 50 * 1024 * 1024, cookies = [] } = {}) {
  const { contentType, body } = await request(url, init, true, maxBytes, { cookies });
  return { buffer: body, contentType };
}
