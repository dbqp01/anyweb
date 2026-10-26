import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WorkflowError } from '../artifact/errors.mjs';
import { loadDeclarations, saveSite, siteFile } from '../artifact/site.mjs';
import { compileRecipe, createRecipeRunner } from '../artifact/recipe.mjs';
import { extractHtml } from '../artifact/html.mjs';
import { document as recordedDocument, marks as recordedMarks } from '../explore/client.mjs';
import { readSession } from '../session.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const fail = (code, details = {}) => { throw new WorkflowError(code, 422, details); };
const same = (a, b) => (typeof a === 'string' || typeof a === 'number') && String(a).trim() === String(b).trim();
// Only identifier-shaped params prove a dependency; matching `quantity=10` against a price is noise.
const identifierParam = name => /(?:^|_)(id|key|sku|isbn|code|slug)$/i.test(name) || /(?:Id|ID)$/.test(name);

function originOf(site) {
  let origin;
  try { origin = new URL(site).origin; } catch { throw new WorkflowError('INVALID_ORIGIN', 400); }
  if (origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  return origin;
}

function toCall(entry, extract, documents) {
  const url = new URL(entry.url);
  const call = {
    origin: url.origin, path: url.pathname, method: entry.method,
    encoding: entry.method === 'GET' ? 'query' : 'json', allow_json_text: false, params: {}, status: entry.status,
  };
  if (entry.method === 'GET') call.params = Object.fromEntries(url.searchParams);
  else {
    const body = entry.request_body;
    if (!/^application\/json(?:\s*;|$)/i.test(entry.request_content_type ?? '') || url.search ||
        !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.values(body).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) {
      throw new WorkflowError('UNSUPPORTED_ENCODING', 422);
    }
    call.params = body;
  }
  if (entry.document_id) {
    if (!extract) throw new WorkflowError('HTML_EXTRACTION_REQUIRED', 422, { url: entry.url });
    const html = documents.get(entry.document_id);
    if (typeof html !== 'string') throw new WorkflowError('HTML_NOT_RECORDED', 422, { url: entry.url });
    call.response = extractHtml(html, entry.url, extract);
    if (call.response === null) throw new WorkflowError('EXTRACTION_FAILED', 422, { url: entry.url });
    call.response_kind = 'html';
  } else if (entry.sha256 && !entry.body) call.response_meta = { content_type: entry.content_type, bytes: entry.bytes, sha256: entry.sha256 };
  else call.response = entry.body;
  return call;
}

function leafValues(value, out = []) {
  if (value && typeof value === 'object') for (const child of Object.values(value)) leafValues(child, out);
  else if (typeof value === 'string' || typeof value === 'number') out.push(value);
  return out;
}

// Page loads fetch incidental JSON (config.json, telemetry). Keep only the calls the last one depends on.
function dependencyChain(calls) {
  // Debounced search-as-you-type hits the same endpoint repeatedly; keep only the final response.
  const latest = new Map();
  for (const call of calls) {
    const signature = `${call.method} ${call.origin}${call.path}`;
    latest.delete(signature); latest.set(signature, call);
  }
  const unique = [...latest.values()];
  if (!unique.length) return [];
  const kept = [unique.length - 1];
  for (let index = unique.length - 2; index >= 0; index--) {
    if (kept.some(next => Object.entries(unique[next].params).some(([param, value]) => identifierParam(param) && leafValues(unique[index].response).some(candidate => same(candidate, value))))) kept.unshift(index);
  }
  return kept.map(index => unique[index]);
}

function selectCalls(mark, effect, allowed, extract, documents) {
  const usable = mark.requests.filter(entry => allowed.has(new URL(entry.url).origin) &&
    ['GET', 'POST'].includes(entry.method) && entry.status >= 200 && entry.status < 300);
  // The recipe model has JSON request bodies only; telemetry POSTs with text bodies are page chrome.
  const json = usable.filter(entry => entry.body !== undefined && /application\/json/i.test(entry.content_type) &&
    (entry.method === 'GET' || (entry.body && typeof entry.body === 'object' && !Array.isArray(entry.body))));
  if (effect === 'read') {
    const readable = [...json, ...(extract ? usable.filter(entry => entry.document_id) : [])].sort((a, b) => a.at - b.at);
    const calls = readable.map(entry => toCall(entry, extract, documents));
    const inputs = new Set(Object.values(mark.input).map(String));
    const anchor = calls.findLastIndex(call => Object.values(call.params).some(param => inputs.has(String(param).trim())));
    if (anchor < 0) return dependencyChain(calls);
    // End the chain at the call that consumes the input; later page chrome (categories, config) is noise.
    const kept = dependencyChain(calls.slice(0, anchor + 1));
    for (let index = anchor + 1; index < calls.length; index++) {
      if (kept.some(prev => Object.entries(calls[index].params).some(([param, value]) => identifierParam(param) && leafValues(prev.response).some(candidate => same(candidate, value))))) kept.push(calls[index]);
    }
    return kept;
  }
  const attachments = usable.filter(entry => entry.sha256 && /attachment/i.test(entry.disposition ?? ''));
  const binaries = attachments.length ? attachments : usable.filter(entry => entry.sha256 && !/^font\//i.test((entry.content_type ?? '').split(';')[0].trim()));
  const last = binaries.at(-1);
  if (!last) fail('DOWNLOAD_NOT_OBSERVED', { tool: mark.tool });
  return [...json.filter(entry => entry.at <= last.at).map(entry => toCall(entry, null, documents)), toCall(last, null, documents)];
}

function inputHashes(marks) {
  const counts = { train: 0, eval: 0 }, hashes = {};
  for (const mark of marks) hashes[`${mark.role}_${counts[mark.role]++}`] = createHash('sha256').update(JSON.stringify(mark.input)).digest('hex');
  return hashes;
}

export async function propose({ site }, env = process.env) {
  const origin = originOf(site);
  const draft = await loadDeclarations(origin, env);
  for (const tool of draft.tools) {
    if (new Set(tool.input_fields).size !== tool.input_fields.length) fail('INVALID_INPUT', { tool: tool.id });
  }
  const recorded = await recordedMarks(origin, env);
  if (recorded.open) fail('MARK_OPEN', { tool: recorded.open.tool });
  const allowed = new Set([draft.origin, ...draft.allowed_origins]);
  // HTML stays in the daemon: only marked documents are fetched, and they never reach site.json.
  const documents = new Map();
  const htmlTools = new Set(draft.tools.filter(tool => tool.execution !== 'browser' && tool.extract).map(tool => tool.id));
  if (htmlTools.size) {
    const ids = [...new Set(recorded.marks.filter(mark => htmlTools.has(mark.tool)).flatMap(mark => mark.requests.flatMap(entry => entry.document_id ? [entry.document_id] : [])))];
    for (const id of ids) documents.set(id, (await recordedDocument(origin, id, env)).html);
  }
  const session = await readSession(draft.origin, draft.session, env);
  const downloadDir = await mkdtemp(join(tmpdir(), 'web2api-verify-'));
  try {
    const tools = [];
    for (const tool of draft.tools) {
      const own = recorded.marks.filter(mark => mark.tool === tool.id);
      const train = own.filter(mark => mark.role === 'train'), held = own.filter(mark => mark.role === 'eval');
      if (train.length !== 2 || held.length !== 1) fail('DEMONSTRATIONS_REQUIRED', { tool: tool.id, train: train.length, held_out: held.length });
      const ordered = [...train, ...held];
      if (new Set(ordered.map(mark => JSON.stringify(mark.input))).size !== ordered.length) fail('INPUTS_NOT_DISTINCT', { tool: tool.id });
      const fields = [...tool.input_fields].sort().join();
      for (const mark of ordered) if (Object.keys(mark.input).sort().join() !== fields) fail('INPUT_MISMATCH', { tool: tool.id });
      if (tool.execution === 'browser') {
        const { proposeBrowser } = await import('./propose-browser.mjs');
        const { recipe, approved } = await proposeBrowser(tool, ordered, draft, session);
        tools.push({ id: tool.id, goal: tool.goal, effect: tool.effect, status: 'proposed', input_fields: recipe.input_fields,
          approved_requests: approved, recipe,
          verification: { status: 'passed', training: 2, held_out: 1, hashes: inputHashes(ordered) }, reviewed_at: null });
        continue;
      }
      const extract = tool.extract ?? null;
      const traces = ordered.map(mark => ({ input: mark.input, calls: selectCalls(mark, tool.effect, allowed, extract, documents) }));
      // WebSocket- or IndexedDB-backed apps produce no replayable HTTP calls; say so instead of crashing later.
      for (const [index, trace] of traces.entries()) if (!trace.calls.length) fail('NO_REPLAYABLE_REQUESTS', { tool: tool.id, role: ordered[index].role });
      for (const trace of traces) for (const call of trace.calls) if (!allowed.has(call.origin)) fail('ORIGIN_NOT_ALLOWED', { tool: tool.id, origin: call.origin });
      if (extract && !traces.some(trace => trace.calls.some(call => call.response_kind === 'html'))) fail('HTML_NOT_OBSERVED', { tool: tool.id });
      const signatures = traces.map(trace => trace.calls.map(call => `${call.origin}${call.path} ${call.method}`).join('|'));
      if (new Set(signatures).size !== 1) fail('INCONSISTENT_DEMONSTRATIONS', { tool: tool.id });
      const kinds = traces.map(trace => trace.calls.map(call => call.response_kind).join('|'));
      if (new Set(kinds).size !== 1) fail('INCONSISTENT_DEMONSTRATIONS', { tool: tool.id });
      const approved = [];
      for (const call of traces[0].calls) if (!approved.some(item => item.origin === call.origin && item.path === call.path && item.method === call.method)) {
        approved.push({ origin: call.origin, path: call.path, method: call.method, allow_json_text: false, success: {} });
      }
      let recipe;
      try { recipe = compileRecipe({ id: tool.id, effect: tool.effect, traces: traces.slice(0, train.length), approvedRequests: approved, session: draft.session, extract }); }
      catch (error) {
        if (error instanceof WorkflowError) { error.tool ??= tool.id; throw error; }
        throw new WorkflowError('UNSUPPORTED_OPERATION', 422, { tool: tool.id, issues: error.issues ?? [] });
      }
      const run = createRecipeRunner(recipe, approved, { session, downloadDir, allowLoopback: LOOPBACK.has(new URL(draft.origin).hostname) });
      for (const [index, trace] of traces.entries()) {
        let result;
        try { result = await run(trace.input); }
        catch (error) {
          if (error instanceof WorkflowError) { error.tool ??= tool.id; error.role ??= ordered[index].role; throw error; }
          throw new WorkflowError('VERIFICATION_FAILED', 502, { tool: tool.id, role: ordered[index].role, detail: error.message });
        }
        if (tool.effect === 'read') {
          // Live HTML legitimately changes between demonstrations (ads, prices); the checks are the contract.
          const html = trace.calls.some(call => call.response_kind === 'html');
          if (html ? result.data === undefined || result.data === null : !isDeepStrictEqual(result.data, trace.calls.at(-1).response)) {
            fail('VERIFICATION_FAILED', { tool: tool.id, role: ordered[index].role });
          }
        } else {
          const meta = trace.calls.at(-1).response_meta;
          if (result.file.sha256 !== meta.sha256 || result.file.bytes !== meta.bytes) fail('VERIFICATION_FAILED', { tool: tool.id, role: ordered[index].role });
        }
      }
      tools.push({
        id: tool.id, goal: tool.goal, effect: tool.effect, status: 'proposed', input_fields: recipe.input_fields,
        approved_requests: approved, recipe,
        verification: { status: 'passed', training: 2, held_out: 1, hashes: inputHashes(ordered) }, reviewed_at: null,
      });
    }
    const compiled_at = new Date().toISOString();
    const engine_hash = createHash('sha256').update(JSON.stringify({ version: '1.0.0', recipes: tools.map(tool => tool.recipe) })).digest('hex');
    const siteArtifact = await saveSite({
      version: 1, origin: draft.origin, allowed_origins: draft.allowed_origins, name: draft.name, created_at: draft.created_at,
      session: draft.session, tools,
      evidence: { actions: recorded.marks.reduce((sum, mark) => sum + mark.actions, 0), requests_observed: recorded.marks.reduce((sum, mark) => sum + mark.requests.length, 0), compiled_at, engine_hash },
    }, env);
    return {
      site: siteArtifact.origin, site_file: siteFile(origin, env),
      tools: siteArtifact.tools.map(tool => ({ id: tool.id, effect: tool.effect, status: tool.status, steps: tool.recipe.steps.length, verification: tool.verification })),
    };
  } finally {
    await rm(downloadDir, { recursive: true, force: true });
  }
}
