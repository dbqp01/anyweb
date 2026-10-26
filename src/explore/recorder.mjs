import { createHash } from 'node:crypto';
import { redact, redactUrl } from '../redact.mjs';

const MAX_BODY = 262144;
const MAX_BINARY = 50 * 1024 * 1024;
const MAX_HTML = 8 * 1024 * 1024;
const MAX_DOCUMENTS = 32;
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_CONSOLE = 200;
const TEXTUAL = /^(text\/|application\/(javascript|xml|css|json))/i;
const HTML = /^(text\/html|application\/xhtml\+xml)$/i;

export function createRecorder(page, { maxBody = MAX_BODY, site = null } = {}) {
  const entries = [], events = [], documents = new Map();
  let nextDocument = 1, documentBytes = 0;
  const sameSite = url => {
    if (!site) return true;
    try { return new URL(url).origin === site; } catch { return false; }
  };
  page.on('response', async response => {
    try {
      const request = response.request();
      const requestHeaders = request.headers();
      const requestType = requestHeaders['content-type'] || '';
      let requestBody;
      // Never retain raw form, multipart, compressed, or malformed request data.
      if (/^application\/json(?:\s*;|$)/i.test(requestType) &&
          (!requestHeaders['content-encoding'] || requestHeaders['content-encoding'] === 'identity')) {
        try {
          const data = request.postDataBuffer();
          if (data && data.length <= maxBody) requestBody = redact(JSON.parse(data.toString('utf8')));
        } catch { /* unsupported request bodies remain unavailable */ }
      }
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const type = contentType.split(';')[0].trim();
      let bytes = Number(headers['content-length'] || 0), body, sha256 = null, documentId;
      if (sameSite(response.url()) && request.resourceType() === 'document' && HTML.test(type) && bytes <= MAX_HTML) {
        const buffer = await response.body();
        bytes = buffer.length;
        if (buffer.length <= MAX_HTML) {
          const html = buffer.toString('utf8');
          documentId = `d${nextDocument++}`;
          documents.set(documentId, { html, bytes: buffer.length });
          documentBytes += buffer.length;
          while (documents.size > MAX_DOCUMENTS || documentBytes > MAX_DOCUMENT_BYTES) {
            const [oldest, value] = documents.entries().next().value;
            documents.delete(oldest);
            documentBytes -= value.bytes;
          }
        }
      } else if (contentType.includes('application/json') && bytes <= maxBody) {
        const buffer = await response.body();
        bytes = buffer.length;
        if (buffer.length <= maxBody) body = redact(JSON.parse(buffer.toString('utf8')));
      } else if (contentType && !TEXTUAL.test(type) && bytes <= MAX_BINARY) {
        const buffer = await response.body();
        bytes = buffer.length;
        sha256 = createHash('sha256').update(buffer).digest('hex');
      }
      entries.push({ method: request.method(), url: redactUrl(response.url()), status: response.status(), content_type: contentType, disposition: headers['content-disposition'] || null, bytes, sha256, body, request_body: requestBody, request_content_type: requestType, document_id: documentId, at: Date.now() });
    } catch { /* bodies are optional evidence */ }
  });
  const record = (type, text) => {
    events.push({ type, text: String(text).slice(0, 2000), at: Date.now() });
    if (events.length > MAX_CONSOLE) events.splice(0, events.length - MAX_CONSOLE);
  };
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) record(message.type(), message.text()); });
  page.on('pageerror', error => record('error', error.message));
  return {
    since: cursor => entries.slice(Math.max(0, cursor)),
    consoleSince: cursor => events.slice(Math.max(0, cursor)),
    cursor: () => entries.length,
    consoleCursor: () => events.length,
    size: () => entries.length,
    document: id => documents.get(id)?.html,
  };
}
