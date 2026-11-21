import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse, WorkflowError } from './errors.mjs';
import { extractSchema } from './html.mjs';
import { readPolicySchema, recipeSchema } from './recipe.mjs';
import { browserRecipeSchema } from './browser.mjs';

const nameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/).refine(s => !['__proto__', 'prototype', 'constructor'].includes(s));
const fieldSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/);
const sessionSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const loopback = host => ['127.0.0.1', 'localhost', '[::1]'].includes(host);

export const originSchema = z.url().refine(value => {
  const url = new URL(value);
  return url.origin === value && !url.username && !url.password &&
    (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)));
}, 'origins must be bare https URLs (loopback http allowed for the fixture)');

export const toolSchema = z.object({
  id: nameSchema,
  goal: z.string().trim().min(5).max(300),
  effect: z.enum(['read', 'download']),
  status: z.enum(['proposed', 'approved', 'rejected']),
  input_fields: z.array(fieldSchema).min(1).max(8),
  approved_requests: z.array(readPolicySchema).min(1).max(128),
  recipe: z.union([recipeSchema, browserRecipeSchema]),
  verification: z.object({
    status: z.enum(['pending', 'passed', 'failed']), training: z.number().int().min(0), held_out: z.number().int().min(0),
    hashes: z.record(z.string(), z.string()),
  }).strict(),
  reviewed_at: z.iso.datetime().nullable().default(null),
}).strict().superRefine((tool, ctx) => {
  if (tool.recipe.id !== tool.id) ctx.addIssue({ code: 'custom', message: 'recipe id must match tool id' });
  if (tool.recipe.effect !== tool.effect) ctx.addIssue({ code: 'custom', message: 'recipe effect must match tool effect' });
  if (tool.recipe.input_fields.join() !== tool.input_fields.join()) ctx.addIssue({ code: 'custom', message: 'recipe inputs must match tool inputs' });
});

export const siteSchema = z.object({
  version: z.literal(1), origin: originSchema, allowed_origins: z.array(originSchema).max(8).default([]),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), created_at: z.iso.datetime(), session: sessionSchema.nullable().default(null),
  tools: z.array(toolSchema).max(16),
  evidence: z.object({ actions: z.number().int().nonnegative(), requests_observed: z.number().int().nonnegative(), compiled_at: z.iso.datetime(), engine_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict().superRefine((site, ctx) => {
  if (new Set(site.tools.map(tool => tool.id)).size !== site.tools.length) ctx.addIssue({ code: 'custom', message: 'tool ids must be unique' });
  if (new Set(site.allowed_origins).size !== site.allowed_origins.length) ctx.addIssue({ code: 'custom', message: 'allowed origins must be unique' });
  if (site.allowed_origins.includes(site.origin)) ctx.addIssue({ code: 'custom', message: 'the site origin is implicit' });
  const allowed = new Set([site.origin, ...site.allowed_origins]);
  for (const tool of site.tools) if (tool.approved_requests.some(request => !allowed.has(request.origin))) ctx.addIssue({ code: 'custom', message: `${tool.id} uses an origin outside allowed_origins` });
});

export const draftSiteSchema = z.object({
  version: z.literal(1), origin: originSchema, allowed_origins: z.array(originSchema).max(8).default([]),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), created_at: z.iso.datetime().default(() => new Date().toISOString()), session: sessionSchema.nullable().default(null),
  tools: z.array(z.object({
    id: nameSchema, goal: z.string().trim().min(5).max(300), effect: z.enum(['read', 'download']).default('read'),
    input_fields: z.array(fieldSchema).min(1).max(8), status: z.literal('proposed').optional(),
    extract: extractSchema.nullable().optional(),
    execution: z.enum(['http', 'browser']).default('http'),
  }).strict()).min(1).max(16),
}).strict().superRefine((site, ctx) => {
  if (new Set(site.tools.map(tool => tool.id)).size !== site.tools.length) ctx.addIssue({ code: 'custom', message: 'tool ids must be unique' });
  if (new Set(site.allowed_origins).size !== site.allowed_origins.length) ctx.addIssue({ code: 'custom', message: 'allowed origins must be unique' });
  if (site.allowed_origins.includes(site.origin)) ctx.addIssue({ code: 'custom', message: 'the site origin is implicit' });
  for (const tool of site.tools) if (tool.execution === 'browser' && (tool.effect !== 'read' || !tool.extract)) {
    ctx.addIssue({ code: 'custom', message: 'browser tools require read effect and DOM extraction' });
  }
});

export const home = (env = process.env) => env.WEB2API_HOME || join(homedir(), '.web2api');
// Hash the canonical origin (scheme + host + port) so http/https and host/port spellings never share storage.
export const siteKey = origin => createHash('sha256').update(new URL(origin).origin).digest('hex');
const legacySiteKey = origin => new URL(origin).host.toLowerCase().replace(/[^a-z0-9.-]/g, '_');
const legacySiteFile = (origin, env) => join(home(env), 'sites', legacySiteKey(origin), 'site.json');
export const siteDir = (origin, env) => join(home(env), 'sites', siteKey(origin));
export const siteFile = (origin, env) => join(siteDir(origin, env), 'site.json');
// Legacy host-keyed sessions/profiles carry no origin proof and are never read automatically.
function checkedSession(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new WorkflowError('INVALID_SESSION', 400);
  return name;
}
export const sessionFile = (origin, env, name = 'default') => checkedSession(name) === 'default'
  ? join(home(env), 'sessions', `${siteKey(origin)}.json`)
  : join(home(env), 'sessions', 'named', siteKey(origin), `${name}.json`);
// Some sites keep auth in IndexedDB, which storageState does not capture.
export const profileDir = (origin, env, name = 'default') => checkedSession(name) === 'default'
  ? join(home(env), 'profiles', siteKey(origin))
  : join(home(env), 'profiles', 'named', siteKey(origin), name);
export const runFile = (origin, env) => join(home(env), 'run', `${siteKey(origin)}.json`);
export const runLog = (origin, env) => join(home(env), 'run', `${siteKey(origin)}.log`);
export const downloadsDir = (origin, env = process.env) =>
  join(env.WEB2API_DOWNLOADS || join(homedir(), 'Downloads'), 'web2api', siteKey(origin));

// Legacy site files live under a host-only key shared by colliding origins; the embedded origin is the only proof of ownership.
async function readSiteRaw(origin, env) {
  let raw;
  try { raw = await readFile(siteFile(origin, env), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (raw !== undefined) {
    let value;
    try { value = JSON.parse(raw); } catch { throw new WorkflowError('INVALID_SITE', 400); }
    if (value?.origin !== origin) throw new WorkflowError('INVALID_SITE', 400);
    return raw;
  }
  try { raw = await readFile(legacySiteFile(origin, env), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new WorkflowError('SITE_NOT_FOUND', 404);
    throw error;
  }
  try { if (JSON.parse(raw).origin === origin) return raw; } catch {}
  throw new WorkflowError('SITE_NOT_FOUND', 404);
}

export async function loadSite(origin, env = process.env) {
  return parse(siteSchema, JSON.parse(await readSiteRaw(origin, env)), 'INVALID_SITE');
}

export async function loadDeclarations(origin, env = process.env) {
  const value = JSON.parse(await readSiteRaw(origin, env));
  const draft = draftSiteSchema.safeParse(value);
  if (draft.success) return draft.data;
  const full = siteSchema.safeParse(value);
  if (full.success) return {
    version: 1, origin: full.data.origin, allowed_origins: full.data.allowed_origins, name: full.data.name,
    created_at: full.data.created_at, session: full.data.session,
    tools: full.data.tools.map(({ id, goal, effect, input_fields, recipe }) => ({
      id, goal, effect, input_fields, execution: recipe.execution ?? 'http',
      extract: recipe.execution === 'browser' ? recipe.extract : recipe.steps.find(step => step.response === 'html')?.extract ?? null,
    })),
  };
  throw new WorkflowError('INVALID_SITE', 502, { issues: full.error.issues });
}

export async function saveSite(site, env = process.env) {
  site = parse(siteSchema, site, 'INVALID_SITE');
  const file = siteFile(site.origin, env), temp = `${file}.${process.pid}.tmp`;
  await mkdir(siteDir(site.origin, env), { recursive: true });
  await writeFile(temp, `${JSON.stringify(site, null, 2)}\n`);
  await rename(temp, file);
  return site;
}
