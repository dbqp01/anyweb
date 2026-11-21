import { WorkflowError } from '../artifact/errors.mjs';

const MAX_JSON = 262144;
const MAX_HTML = 8 * 1024 * 1024;
const TIMEOUT_MS = 15000;

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

function statusError(response) {
  if (response.status === 401 || response.status === 403) return new WorkflowError('REAUTH_REQUIRED', 401);
  if (response.status === 429) return new WorkflowError('RATE_LIMITED', 429);
  if (response.status === 404) return new WorkflowError('UPSTREAM_CHANGED');
  if (response.status === 409) return new WorkflowError('UPSTREAM_CONFLICT', 409);
  return new WorkflowError('UPSTREAM_UNAVAILABLE');
}

async function request(url, init, binary, limit, { redirects = 0, cookies = [], detectLoginRedirect = false, redirectAllowed = () => true } = {}) {
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
      const response = await fetch(current, { ...init, headers, redirect: 'manual', signal });
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
        if (!response.ok) throw statusError(response);
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
    throw new WorkflowError(['TimeoutError', 'AbortError'].includes(error?.name) ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
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
  return { html: body.toString('utf8'), url: finalUrl };
}

export async function upstreamBinary(url, init = {}, { maxBytes = 50 * 1024 * 1024, cookies = [] } = {}) {
  const { contentType, body } = await request(url, init, true, maxBytes, { cookies });
  return { buffer: body, contentType };
}
