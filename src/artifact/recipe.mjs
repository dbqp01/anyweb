import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, WorkflowError } from './errors.mjs';
import { extractHtml, extractSchema, MAX_ROWS } from './html.mjs';
import { upstreamBinary, upstreamHtml, upstreamJson } from '../net/upstream.mjs';
import { isSensitiveKey, redact, redactUrl } from '../redact.mjs';

const key = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/).refine(s => !['__proto__', 'prototype', 'constructor'].includes(s));
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const pathSegment = z.string().regex(/^(?:[a-zA-Z_][a-zA-Z0-9_-]{0,79}|\d{1,6})$/).refine(s => !['__proto__', 'prototype', 'constructor'].includes(s));
const fieldPath = z.string().max(250).refine(s => s.split('.').every(part => pathSegment.safeParse(part).success));
const route = z.string().regex(/^\/[a-zA-Z0-9_./=-]*$/).refine(s => s.split('/').every(part => part !== '..'), 'path must not traverse');
const binding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: scalar }).strict(),
  z.object({ kind: z.literal('input'), field: key, cast: z.enum(['string', 'number']) }).strict(),
  z.object({ kind: z.literal('selection'), step: z.number().int().min(0).max(7), collection: fieldPath, match_field: fieldPath, input: key, value_field: fieldPath, cast: z.enum(['string', 'number']) }).strict(),
]);
const shapeSchema = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.enum(['string', 'number', 'boolean', 'null', 'any']) }).strict(),
  z.object({ type: z.literal('nullable'), of: shapeSchema }).strict(),
  z.object({ type: z.literal('object'), fields: z.record(key, shapeSchema) }).strict(),
  z.object({ type: z.literal('array'), item: shapeSchema.nullable() }).strict(),
]));
const checkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contains_any'), input: key, fields: z.array(fieldPath).min(1).max(30), terminal_collection: fieldPath.nullable() }).strict(),
  z.object({ kind: z.literal('join'), step: z.number().int().min(0).max(7), collection: fieldPath, terminal_collection: fieldPath.nullable(), identity: fieldPath, fields: z.array(fieldPath).min(2).max(30) }).strict(),
  z.object({ kind: z.literal('complete_search'), step: z.number().int().min(0).max(7), collection: fieldPath, terminal_collection: fieldPath, identity: fieldPath,
    filters: z.array(z.object({ input: key, fields: z.array(fieldPath).min(1).max(30) }).strict()).min(1).max(8) }).strict(),
]);
const requestSchema = z.object({
  origin: z.url(), path: route, method: z.enum(['GET', 'POST']), encoding: z.enum(['query', 'json', 'form']),
  allow_json_text: z.boolean().default(false), response: z.enum(['json', 'html', 'binary']).default('json'),
  extract: extractSchema.nullable().default(null),
  params: z.record(key, binding), shape: shapeSchema.nullable().default(null), success: z.record(fieldPath, scalar).default({}),
  save: z.object({ filename: z.string().min(1).max(120) }).strict().nullable().default(null),
}).strict()
export const readPolicySchema = requestSchema.pick({ origin: true, path: true, method: true, allow_json_text: true, success: true })
  .extend({ allow_json_text: z.boolean().default(false), success: z.record(fieldPath, scalar).default({}),
    // Absent means "no query was reviewed": query-bearing requests stay blocked.
    // Only the browser runner enforces this; HTTP recipes bind every parameter in `params`.
    query: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('literal'), name: key, value: z.string().max(1000) }).strict(),
      z.object({ kind: z.literal('input'), name: key, field: key }).strict(),
    ])).max(8).default([]) })
  .superRefine((policy, ctx) => {
    const names = policy.query.map(rule => rule.name);
    if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'query rules must be unique' });
    if (names.some(isSensitiveKey)) ctx.addIssue({ code: 'custom', message: 'secret query parameters cannot be approved' });
  });
const downloadSchema = z.object({
  content_types: z.array(z.string().min(1).max(200)).min(1).max(8),
  max_bytes: z.number().int().min(1).max(50 * 1024 * 1024).default(50 * 1024 * 1024),
  filename: z.string().min(1).max(120),
}).strict();
const sessionName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const recipeSchema = z.object({
  version: z.literal(4), id: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/), effect: z.enum(['read', 'download']),
  source_mode: z.enum(['observed_first_party_http', 'documented_api']), session: sessionName.nullable().default(null),
  input_fields: z.array(key).min(1).max(8), steps: z.array(requestSchema).min(1).max(8),
  checks: z.array(checkSchema).max(16).default([]), download: downloadSchema.nullable().default(null),
  impl: z.null().default(null), observed_at: z.iso.datetime(),
  discovery: z.literal('demonstration_guided_dependency_inference'),
}).strict().superRefine((recipe, ctx) => {
  const last = recipe.steps.at(-1);
  const readable = step => ['json', 'html'].includes(step.response) && !!step.shape &&
    (step.response === 'html' ? !!step.extract : step.extract === null);
  if (recipe.effect === 'read') {
    if (!recipe.checks.length) ctx.addIssue({ code: 'custom', message: 'read recipes need checks' });
    if (recipe.download) ctx.addIssue({ code: 'custom', message: 'read recipes cannot download' });
    if (recipe.steps.some(step => !readable(step))) ctx.addIssue({ code: 'custom', message: 'read steps need a JSON or extracted HTML shape' });
  } else {
    if (recipe.download === null) ctx.addIssue({ code: 'custom', message: 'download recipes need a download policy' });
    if (recipe.checks.length) ctx.addIssue({ code: 'custom', message: 'download recipes do not use checks' });
    if (last.response !== 'binary' || last.shape || last.extract) ctx.addIssue({ code: 'custom', message: 'the last download step must be binary' });
    if (recipe.steps.slice(0, -1).some(step => !readable(step))) ctx.addIssue({ code: 'custom', message: 'prior download steps must be JSON or extracted HTML' });
  }
});

const traceCallSchema = z.object({
  origin: z.url(), path: route, method: z.enum(['GET', 'POST']), encoding: z.enum(['query', 'json', 'form']),
  allow_json_text: z.boolean().default(false), params: z.record(key, scalar), status: z.number().int(),
  response: z.unknown().optional(), response_kind: z.enum(['json', 'html']).default('json'),
  response_meta: z.object({ content_type: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
const traceSchema = z.object({ input: z.record(key, z.string().max(120)), calls: z.array(traceCallSchema).min(1).max(8) }).strict();

function fail(code, status = 502) { throw new WorkflowError(code, status); }
const same = (a, b) => (typeof a === 'string' || typeof a === 'number') && String(a).trim() === String(b).trim();
const collections = object => leaves(object).filter(([, value]) => Array.isArray(value) && value.every(row => row && typeof row === 'object' && !Array.isArray(row)));
function leaves(object, prefix = '') {
  return Object.entries(object ?? {}).flatMap(([field, value]) => {
    const path = prefix ? `${prefix}.${field}` : field;
    if (value && typeof value === 'object' && !Array.isArray(value)) return leaves(value, path);
    return [[path, value]];
  });
}
const atPath = (object, path) => path.split('.').reduce((value, part) => value && Object.hasOwn(value, part) ? value[part] : undefined, object);
const includes = (value, query) => typeof value === 'string' && value.toLowerCase().includes(query.toLowerCase());
const matchingRows = (rows, filters, input) => rows.filter(row => filters.every(filter => filter.fields.some(field => includes(atPath(row, field), input[filter.input]))));
function sameIds(expected, actual, identity) {
  const ids = rows => rows.map(row => atPath(row, identity)).map(value => typeof value === 'string' || typeof value === 'number' ? String(value) : null);
  const left = ids(expected), right = ids(actual);
  return !left.includes(null) && !right.includes(null) && new Set(left).size === left.length && new Set(right).size === right.length && isDeepStrictEqual(left.sort(), right.sort());
}

function shapeOf(value, depth = 0) {
  if (depth > 6) fail('RESPONSE_TOO_COMPLEX');
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', item: value.length ? value.map(item => shapeOf(item, depth + 1)).reduce(mergeShape) : null };
  if (typeof value === 'object') return { type: 'object', fields: Object.fromEntries(Object.entries(value).map(([field, child]) => { parse(key, field, 'UNSAFE_FIELD'); return [field, shapeOf(child, depth + 1)]; })) };
  return { type: typeof value };
}

// Lists mix nulls and shapes (thumbnails, optional fields); keep the common fields and allow null.
function mergeShape(a, b) {
  if (isDeepStrictEqual(a, b)) return a;
  if (a.type === 'nullable' && b.type === 'null') return a;
  if (b.type === 'nullable' && a.type === 'null') return b;
  if (a.type === 'null') return { type: 'nullable', of: b };
  if (b.type === 'null') return { type: 'nullable', of: a };
  if (a.type === 'nullable' || b.type === 'nullable') {
    if (a.type === 'nullable' && b.type === 'nullable') return { type: 'nullable', of: mergeShape(a.of, b.of) };
    return { type: 'nullable', of: mergeShape(a.type === 'nullable' ? a.of : a, b.type === 'nullable' ? b.of : b) };
  }
  if (a.type === 'object' && b.type === 'object') {
    const fields = Object.fromEntries([...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])]
      .map(field => [field, mergeShape(a.fields[field] ?? { type: 'null' }, b.fields[field] ?? { type: 'null' })]));
    return { type: 'object', fields };
  }
  if (a.type === 'array' && b.type === 'array') {
    if (!a.item || !b.item) return { type: 'array', item: a.item ?? b.item ?? null };
    const item = mergeShape(a.item, b.item);
    return item ? { type: 'array', item } : null;
  }
  // Conflicting types across demonstrations mean the upstream shape is not stable.
  return null;
}

function matches(shape, value) {
  if (!shape || typeof shape !== 'object') return false;
  if (shape.type === 'any') return true;
  if (shape.type === 'nullable') return value === null || matches(shape.of, value);
  if (shape.type === 'null') return value === null;
  if (shape.type === 'array') return Array.isArray(value) && value.length <= MAX_ROWS && (!shape.item || value.every(item => matches(shape.item, item)));
  if (shape.type === 'object') return value && typeof value === 'object' && !Array.isArray(value) && Object.entries(shape.fields).every(([field, child]) => Object.hasOwn(value, field) && matches(child, value[field]));
  return typeof value === shape.type && (typeof value !== 'number' || Number.isFinite(value));
}

function responseBinding(traces, step, param) {
  const candidates = [];
  for (let previous = 0; previous < step; previous++) {
    for (const [collection, rows] of collections(traces[0].calls[previous].response)) {
      if (!rows.length) continue;
      for (const [value_field] of leaves(rows[0])) for (const [match_field] of leaves(rows[0])) for (const input of Object.keys(traces[0].input)) {
        if (new Set(traces.map(t => t.input[input])).size < 2) continue;
        const proven = traces.every(t => {
          const matches = atPath(t.calls[previous].response, collection)?.filter(row => same(atPath(row, match_field), t.input[input]));
          return matches?.length === 1 && same(atPath(matches[0], value_field), t.calls[step].params[param]);
        });
        if (proven) candidates.push({ kind: 'selection', step: previous, collection, match_field, input, value_field, cast: typeof traces[0].calls[step].params[param] });
      }
    }
  }
  if (candidates.length !== 1) fail(candidates.length ? 'AMBIGUOUS_DEPENDENCY' : 'UNBOUND_DYNAMIC_VALUE');
  return candidates[0];
}

function inferChecks(traces) {
  const checks = [], end = traces[0].calls.length - 1, last = traces[0].calls[end].response;
  for (let step = 0; step < end; step++) for (const [collection, rows] of collections(traces[0].calls[step].response)) {
    const terminal = Array.isArray(last) ? null : collections(last)[0]?.[0];
    const outputs = terminal ? atPath(last, terminal) : [last];
    if (!rows.length || !outputs.length) continue;
    for (const [identity, value] of leaves(outputs[0])) {
      if (!['string', 'number'].includes(typeof value)) continue;
      const fields = leaves(outputs[0]).filter(([, value]) => value === null || ['string', 'number', 'boolean'].includes(typeof value)).map(([field]) => field).filter(field => atPath(rows[0], field) !== undefined);
      if (fields.length < 2) continue;
      if (traces.every(t => {
        const results = terminal ? atPath(t.calls[end].response, terminal) : [t.calls[end].response];
        const catalog = atPath(t.calls[step].response, collection);
        if (new Set(catalog.map(row => atPath(row, identity))).size !== catalog.length) return false;
        return results.every(result => {
          const candidates = catalog.filter(row => same(atPath(row, identity), atPath(result, identity)));
          return candidates.length === 1 && fields.every(field => isDeepStrictEqual(atPath(candidates[0], field), atPath(result, field)));
        });
      })) { checks.push({ kind: 'join', step, collection, terminal_collection: terminal ?? null, identity, fields }); break; }
    }
  }
  const terminal = collections(last)[0]?.[0];
  const outputs = terminal ? atPath(last, terminal) : [last];
  for (const input of Object.keys(traces[0].input)) {
    const fields = leaves(outputs[0]).filter(([, value]) => typeof value === 'string').map(([field]) => field).filter(field => traces.some(t => {
      const results = terminal ? atPath(t.calls[end].response, terminal) : [t.calls[end].response];
      return results.some(row => includes(atPath(row, field), t.input[input]));
    }));
    if (fields.length && traces.every(t => {
      const results = terminal ? atPath(t.calls[end].response, terminal) : [t.calls[end].response];
      return results.length && results.some(row => fields.some(field => includes(atPath(row, field), t.input[input])));
    })) checks.push({ kind: 'contains_any', input, fields, terminal_collection: terminal ?? null });
  }
  // A single observed call (e.g. search) has no cross-call join to prove.
  const needsJoin = traces[0].calls.length > 1;
  if (!checks.some(c => c.kind === 'contains_any') || (needsJoin && !checks.some(c => c.kind === 'join'))) fail('UNVERIFIABLE_WORKFLOW');
  if (terminal && needsJoin) {
    const filters = checks.filter(c => c.kind === 'contains_any').map(({ input, fields }) => ({ input, fields }));
    const candidates = checks.filter(c => c.kind === 'join' && c.terminal_collection === terminal && traces.every(t => {
      const catalog = atPath(t.calls[c.step].response, c.collection), actual = atPath(t.calls[end].response, terminal);
      return new Set(catalog.map(row => String(atPath(row, c.identity)))).size === catalog.length && sameIds(matchingRows(catalog, filters, t.input), actual, c.identity);
    }));
    if (candidates.length !== 1) fail('UNPROVEN_SEARCH_COMPLETENESS');
    const { step, collection, identity } = candidates[0];
    checks.push({ kind: 'complete_search', step, collection, terminal_collection: terminal, identity, filters });
  }
  return checks;
}

export function compileRecipe({ id, effect = 'read', traces: rawTraces, approvedRequests, sourceMode = 'observed_first_party_http', session = null, extract = null }) {
  const traces = z.array(traceSchema).min(2).max(20).parse(rawTraces);
  if (traces.some(t => !t.calls.length)) fail('API_PATH_NOT_OBSERVED');
  const htmlSteps = traces[0].calls.filter(call => call.response_kind === 'html').length;
  if (htmlSteps && !extract) fail('HTML_EXTRACTION_REQUIRED');
  // One extraction map per tool in this slice; a later version can key maps by step.
  if (htmlSteps > 1) fail('AMBIGUOUS_EXTRACTION');
  const input_fields = Object.keys(traces[0].input);
  input_fields.forEach(field => parse(key, field, 'UNSAFE_FIELD'));
  if (!input_fields.length || input_fields.some(field => new Set(traces.map(t => t.input[field])).size < 2)) fail('UNPROVEN_PARAMETER');
  if (traces.some(t => t.calls.length !== traces[0].calls.length)) fail('AMBIGUOUS_OPERATION');
  // Optional literals (search tuning, tracking flags) that only some demonstrations sent are not part of the contract.
  for (let step = 0; step < traces[0].calls.length; step++) {
    for (const param of new Set(traces.flatMap(t => Object.keys(t.calls[step].params)))) {
      const present = traces.filter(t => Object.hasOwn(t.calls[step].params, param));
      if (present.length === traces.length) continue;
      const value = present[0].calls[step].params[param];
      if (!present.every(t => isDeepStrictEqual(t.calls[step].params[param], value))) fail('AMBIGUOUS_PARAMETER');
      for (const trace of traces) delete trace.calls[step].params[param];
    }
  }
  const steps = traces[0].calls.map((call, step) => {
    const approved = approvedRequests.find(r => r.origin === call.origin && r.path === call.path && r.method === call.method && !!r.allow_json_text === !!call.allow_json_text);
    if (!approved) fail('UNREVIEWED_OPERATION');
    const success = approved.success ?? {};
    if (traces.some(t => Object.entries(success).some(([field, expected]) => !isDeepStrictEqual(atPath(t.calls[step].response, field), expected)))) fail('UPSTREAM_REJECTED');
    if (traces.some(t => t.calls[step].status !== 200 || ['origin', 'path', 'method', 'encoding'].some(k => t.calls[step][k] !== call[k]))) fail('AMBIGUOUS_OPERATION');
    const params = {};
    for (const [param, value] of Object.entries(call.params)) {
      parse(key, param, 'UNSAFE_FIELD');
      // A literal `token=0` is a public upstream flag; anything else named like a credential stays out of recipes.
      const publicToken = param.toLowerCase() === 'token' &&
        traces.every(t => isDeepStrictEqual(t.calls[step].params[param], value)) && /^[0-9]{1,2}$/.test(String(value));
      if (!publicToken && isSensitiveKey(param)) fail('SECRET_IN_RECIPE');
      const candidates = input_fields.filter(field => traces.every(t => same(t.input[field], t.calls[step].params[param])));
      if (candidates.length > 1) fail('AMBIGUOUS_PARAMETER');
      if (candidates.length === 1) params[param] = { kind: 'input', field: candidates[0], cast: typeof value };
      else if (traces.every(t => isDeepStrictEqual(t.calls[step].params[param], value))) params[param] = { kind: 'literal', value };
      else params[param] = responseBinding(traces, step, param);
    }
    if (traces.some(t => !isDeepStrictEqual(Object.keys(t.calls[step].params).sort(), Object.keys(call.params).sort()))) fail('AMBIGUOUS_PARAMETER');
    const isBinary = effect === 'download' && step === traces[0].calls.length - 1;
    if (isBinary) {
      if (traces.some(t => !t.calls[step].response_meta)) fail('BINARY_RESPONSE_NOT_RECORDED');
      return { origin: call.origin, path: call.path, method: call.method, encoding: call.encoding, allow_json_text: !!call.allow_json_text,
        response: 'binary', params, shape: null, success, save: { filename: id } };
    }
    const shape = traces.map(t => shapeOf(t.calls[step].response)).reduce(mergeShape);
    if (!traces.every(t => t.calls[step].response !== undefined && matches(shape, t.calls[step].response))) fail('RESPONSE_SHAPE_UNSTABLE');
    const isHtml = call.response_kind === 'html';
    return { origin: call.origin, path: call.path, method: call.method, encoding: call.encoding, allow_json_text: !!call.allow_json_text,
      response: isHtml ? 'html' : 'json', extract: isHtml ? extract : null, params, shape, success, save: null };
  });
  for (const input of input_fields) if (!steps.some(s => Object.values(s.params).some(p => p.field === input || p.input === input))) fail('UNUSED_INPUT');
  const download = effect === 'download' ? {
    content_types: [...new Set(traces.map(t => t.calls.at(-1).response_meta.content_type.split(';')[0].trim()))],
    max_bytes: Math.min(50 * 1024 * 1024, Math.max(1024 * 1024, Math.max(...traces.map(t => t.calls.at(-1).response_meta.bytes)) * 4)),
    filename: id,
  } : null;
  return parse(recipeSchema, {
    version: 4, id, effect, source_mode: sourceMode, session, input_fields, steps,
    checks: effect === 'read' ? inferChecks(traces) : [], download, impl: null,
    observed_at: new Date().toISOString(), discovery: 'demonstration_guided_dependency_inference',
  }, 'INVALID_RECIPE');
}

export function readWorkflowInput(recipe) {
  return z.object(Object.fromEntries(recipe.input_fields.map(field => [field, z.string().trim().min(1).max(120)]))).strict();
}

function toZod(shape) {
  if (shape.type === 'nullable') return toZod(shape.of).nullable();
  if (shape.type === 'object') return z.object(Object.fromEntries(Object.entries(shape.fields).map(([field, child]) => [field, toZod(child)])));
  if (shape.type === 'array') return z.array(shape.item ? toZod(shape.item) : z.unknown()).max(MAX_ROWS);
  // Leaf types drift on real APIs (text on one row, an object on another); the object and array
  // skeleton is the enforceable output contract.
  return z.unknown();
}

export function readWorkflowOutput(recipe) {
  return z.object({ data: toZod(recipe.steps.at(-1).shape), evidence: z.object({
    source_mode: z.enum(['observed_first_party_http', 'documented_api']), transport: z.literal('http_only'), observed_at: z.iso.datetime(), workflow: z.string(), effect: z.literal('read'), steps_completed: z.number().int(),
    calls: z.array(z.object({ method: z.enum(['GET', 'POST']), url: z.url(), parameters: z.array(z.string()), status: z.number().int() })), verification: z.array(checkSchema),
    discovery: z.literal('demonstration_guided_dependency_inference'), autonomous_discovery: z.literal(false),
  }) });
}

export function downloadWorkflowOutput() {
  return z.object({ file: z.object({ path: z.string(), bytes: z.number().int().nonnegative(), content_type: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    evidence: z.object({ source_mode: z.enum(['observed_first_party_http', 'documented_api']), transport: z.literal('http_only'), observed_at: z.iso.datetime(), workflow: z.string(), effect: z.literal('download'),
      steps_completed: z.number().int(), calls: z.array(z.object({ method: z.enum(['GET', 'POST']), url: z.url(), parameters: z.array(z.string()), status: z.number().int() })) }) }).strict();
}

function checkOrigin(step, allowLoopback) {
  const origin = new URL(step.origin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  if (origin.origin !== step.origin || origin.username || origin.password) fail('ORIGIN_REJECTED');
  if (origin.protocol !== 'https:' && !(allowLoopback && origin.protocol === 'http:' && loopback)) fail('ORIGIN_REJECTED');
  if (step.path.includes('//') || step.path.includes('..')) fail('ORIGIN_REJECTED');
}

function safeFilename(name) {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120);
  return clean || 'download';
}

const extension = contentType => ({
  'application/pdf': '.pdf', 'application/json': '.json', 'text/csv': '.csv', 'text/plain': '.txt',
  'application/zip': '.zip', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
})[contentType.split(';')[0].trim()] || '.bin';

function renderFilename(template, input, contentType) {
  const rendered = template.replace(/\{input\.([a-zA-Z_][a-zA-Z0-9_]{0,79})\}/g, (_, field) => input[field] ?? '');
  const name = safeFilename(rendered);
  return /\.[a-zA-Z0-9]{1,8}$/.test(name) ? name : `${name}${extension(contentType)}`;
}

async function writeUnique(directory, filename, buffer) {
  await mkdir(directory, { recursive: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    const path = join(directory, attempt ? filename.replace(/(\.[^.]+)?$/, `-${attempt}$1`) : filename);
    try {
      await writeFile(path, buffer, { flag: 'wx' });
      return path;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  fail('DOWNLOAD_NAME_EXHAUSTED', 409);
}

export function createRecipeRunner(recipe, approvedRequests, { session = null, downloadDir, allowLoopback = false, onStep = () => {} } = {}) {
  recipe = parse(recipeSchema, recipe, 'INVALID_RECIPE');
  // shortcut: POST effects are unproven; enable only after a trusted approval policy exists.
  if (recipe.steps.some(step => step.method !== 'GET')) fail('UNSAFE_METHOD_UNSUPPORTED', 422);
  if (recipe.steps.some(s => !approvedRequests.some(r => r.origin === s.origin && r.path === s.path && r.method === s.method && !!r.allow_json_text === s.allow_json_text && isDeepStrictEqual(r.success ?? {}, s.success)))) fail('UNREVIEWED_OPERATION');
  for (const step of recipe.steps) checkOrigin(step, allowLoopback);
  if (recipe.effect === 'download' && !downloadDir) fail('DOWNLOAD_DIR_REQUIRED', 500);
  if (recipe.session && !session) fail('REAUTH_REQUIRED', 401);
  const sessionHeaders = { ...session?.headers };
  // Raw session headers carry no destination metadata; never spread them across origins.
  if (Object.keys(sessionHeaders).length && new Set(recipe.steps.map(step => step.origin)).size > 1) fail('SESSION_HEADERS_UNSCOPED', 400);
  return async raw => {
    const input = parse(readWorkflowInput(recipe), raw), results = [], calls = [];
    for (let index = 0; index < recipe.steps.length; index++) {
      const step = recipe.steps[index], params = {};
      for (const [name, binding] of Object.entries(step.params)) {
        let value;
        if (binding.kind === 'literal') value = binding.value;
        else if (binding.kind === 'input') value = input[binding.field];
        else {
          if (binding.step >= index) fail('INVALID_DEPENDENCY');
          const rows = atPath(results[binding.step], binding.collection);
          const selected = rows?.filter(row => same(atPath(row, binding.match_field), input[binding.input]));
          if (!selected?.length) throw new WorkflowError('NO_MATCH', 404);
          if (selected.length !== 1) fail('AMBIGUOUS_RESULT');
          value = atPath(selected[0], binding.value_field);
        }
        params[name] = binding.kind === 'literal' ? value : binding.cast === 'number' ? Number(value) : String(value);
        if (params[name] === undefined || (typeof params[name] === 'number' && !Number.isFinite(params[name]))) fail('INVALID_DEPENDENCY');
      }
      const url = new URL(step.path, step.origin);
      const accept = step.response === 'binary' ? '*/*' : step.response === 'html' ? 'text/html,application/xhtml+xml' : 'application/json';
      const init = { method: step.method, headers: { Accept: accept, ...sessionHeaders } };
      if (step.encoding === 'query') url.search = new URLSearchParams(params);
      else {
        init.headers['Content-Type'] = step.encoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json';
        init.body = step.encoding === 'form' ? new URLSearchParams(params).toString() : JSON.stringify(params);
      }
      if (step.response === 'binary') {
        let buffer, contentType;
        try { ({ buffer, contentType } = await upstreamBinary(url, init, { maxBytes: recipe.download.max_bytes, cookies: session?.cookies })); }
        catch (error) { if (error instanceof WorkflowError) { error.tool ??= recipe.id; error.step ??= index; } throw error; }
        const type = contentType.split(';')[0].trim().toLowerCase();
        if (!recipe.download.content_types.some(allowed => allowed.split(';')[0].trim().toLowerCase() === type)) fail('UPSTREAM_CHANGED');
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const path = await writeUnique(downloadDir, renderFilename(step.save.filename, input, contentType), buffer);
        const call = { method: step.method, url: redactUrl(url.href), parameters: Object.keys(params), status: 200 };
        onStep({ step: index, ...call, content_type: contentType, bytes: buffer.length });
        return { file: { path, bytes: buffer.length, content_type: contentType, sha256 },
          evidence: { source_mode: recipe.source_mode, transport: 'http_only', observed_at: new Date().toISOString(), workflow: recipe.id, effect: 'download', steps_completed: index + 1, calls: [...calls, call] } };
      }
      let response;
      try {
        if (step.response === 'html') {
          const { html, url: finalUrl } = await upstreamHtml(url, init, { cookies: session?.cookies, detectLoginRedirect: !!recipe.session,
            redirectAllowed: (target, method) => approvedRequests.some(request => request.origin === target.origin && request.path === target.pathname && request.method === method) });
          response = extractHtml(html, finalUrl, step.extract);
          if (response === null) fail('UPSTREAM_CHANGED');
        } else response = await upstreamJson(url, init, { allowJsonText: step.allow_json_text, cookies: session?.cookies });
      } catch (error) { if (error instanceof WorkflowError) { error.tool ??= recipe.id; error.step ??= index; } throw error; }
      if (Object.entries(step.success).some(([field, expected]) => !isDeepStrictEqual(atPath(response, field), expected))) fail('UPSTREAM_REJECTED');
      // Shape is advisory: real APIs vary optional fields (Wikipedia returns an object for the
      // description of a few pages); the checks below are the contract.
      results.push(response);
      const call = { method: step.method, url: redactUrl(url.href), parameters: Object.keys(params), status: 200 };
      calls.push(call);
      onStep({ step: index, ...call, content_type: step.response === 'html' ? 'text/html' : 'application/json', preview: redact(response) });
    }
    const output = results.at(-1);
    for (const check of recipe.checks) {
      const rows = check.terminal_collection ? atPath(output, check.terminal_collection) : [output];
      if (!Array.isArray(rows)) fail('INVALID_POSTCONDITION');
      if (check.kind === 'contains_any') {
        // Ranked search may return fuzzy neighbors; one row carrying the query is the contract.
        if (!rows.some(row => check.fields.some(field => includes(atPath(row, field), input[check.input])))) fail('VERIFICATION_FAILED');
      } else if (check.kind === 'join') {
        if (rows.some(row => {
          const matches = atPath(results[check.step], check.collection)?.filter(prior => same(atPath(prior, check.identity), atPath(row, check.identity)));
          return matches?.length !== 1 || check.fields.some(field => !isDeepStrictEqual(atPath(matches[0], field), atPath(row, field)));
        })) fail('VERIFICATION_FAILED');
      } else if (check.kind === 'complete_search') {
        const catalog = atPath(results[check.step], check.collection);
        if (!Array.isArray(catalog) || new Set(catalog.map(row => String(atPath(row, check.identity)))).size !== catalog.length ||
            !sameIds(matchingRows(catalog, check.filters, input), rows, check.identity)) fail('SEARCH_INCOMPLETE');
      } else fail('INVALID_POSTCONDITION');
    }
    return parse(readWorkflowOutput(recipe), { data: redact(output), evidence: { source_mode: recipe.source_mode, transport: 'http_only', observed_at: new Date().toISOString(),
      workflow: recipe.id, effect: 'read', steps_completed: results.length, calls, verification: recipe.checks, discovery: recipe.discovery, autonomous_discovery: false } }, 'UPSTREAM_CHANGED');
  };
}
