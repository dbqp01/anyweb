import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WorkflowError } from '../artifact/errors.mjs';
import { draftSiteSchema, home, loadDeclarations, loadSite, originSchema } from '../artifact/site.mjs';
import { redact, redactUrl } from '../redact.mjs';
import { initSite } from '../commands/init.mjs';
import * as explore from '../commands/explore.mjs';
import { propose } from '../commands/propose.mjs';

const SESSION = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOOL = /^[a-z][a-z0-9_]{1,79}$/;
const REF = /^[a-z][a-z0-9]*$/i;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const LOCAL_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const BROWSER = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

function sameSiteUrl(site, value) {
  const target = new URL(value);
  if (target.origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  if (target.username || target.password) throw new WorkflowError('INVALID_INPUT', 400, { detail: 'URL credentials are not accepted' });
  if (redactUrl(target.href) !== target.href) throw new WorkflowError('BROWSER_SECRET_INPUT', 400);
  return target.href;
}

// The declaration arrives inline; the only file written is a short-lived copy under the factory home.
async function initInline(declaration) {
  const dir = join(home(), 'factory');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomBytes(8).toString('hex')}.json`);
  await writeFile(file, `${JSON.stringify(declaration)}\n`, { mode: 0o600 });
  try {
    const { file: _ignored, ...result } = await initSite({ file });
    return result;
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
}

async function siteStatus({ site }) {
  let compiled = null;
  try { compiled = await loadSite(site); }
  catch (error) { if (error.code !== 'INVALID_SITE') throw error; }
  if (compiled) {
    return {
      site: compiled.origin, name: compiled.name, stage: 'compiled',
      tools: compiled.tools.map(tool => ({
        id: tool.id, goal: tool.goal, effect: tool.effect, execution: tool.recipe.execution ?? 'http', input_fields: tool.input_fields,
        status: tool.status, verification: tool.verification.status, reviewed_at: tool.reviewed_at,
      })),
      evidence: {
        actions: compiled.evidence.actions, requests_observed: compiled.evidence.requests_observed,
        compiled_at: compiled.evidence.compiled_at,
      },
    };
  }
  const draft = await loadDeclarations(site);
  return {
    site: draft.origin, name: draft.name, stage: 'declared',
    tools: draft.tools.map(tool => ({
      id: tool.id, goal: tool.goal, effect: tool.effect, execution: tool.execution,
      input_fields: tool.input_fields, status: 'draft',
    })),
    evidence: null,
  };
}

const siteOnly = z.object({ site: originSchema }).strict();

const tools = [
  {
    name: 'init_site',
    config: {
      title: 'Declare an AnyWeb site',
      description: 'Validate and save a site declaration. The declaration is passed inline; there is no path argument and an existing site is never overwritten.',
      inputSchema: draftSiteSchema, annotations: LOCAL_WRITE,
    },
    run: initInline,
  },
  {
    name: 'explore_start',
    config: {
      title: 'Start the explore daemon',
      description: 'Start a local Chromium session for one site origin. Use a saved session name only; this tool does not accept credentials.',
      inputSchema: z.object({
        site: originSchema, start_url: z.url(), session: z.string().regex(SESSION).optional(),
        budget_actions: z.number().int().positive().optional(), budget_minutes: z.number().int().positive().optional(),
      }).strict(),
      annotations: BROWSER,
    },
    run: async ({ site, start_url, session, budget_actions, budget_minutes }) => {
      await loadDeclarations(site);
      return explore.start({ site, startUrl: sameSiteUrl(site, start_url), session, budgetActions: budget_actions, budgetMinutes: budget_minutes });
    },
  },
  {
    name: 'explore_open',
    config: {
      title: 'Open a page on the site',
      description: 'Navigate the explore daemon to a URL on the same site origin. The site must be declared first; URLs with embedded credentials are refused.',
      inputSchema: z.object({ site: originSchema, url: z.url() }).strict(), annotations: BROWSER,
    },
    run: async ({ site, url }) => {
      await loadDeclarations(site);
      return explore.open({ site, url: sameSiteUrl(site, url) });
    },
  },
  {
    name: 'explore_click',
    config: {
      title: 'Click an aria ref',
      description: 'Click an element by its aria ref. Non-GET requests are blocked; GET can still have side effects. No approval for writes is available.',
      inputSchema: z.object({ site: originSchema, ref: z.string().regex(REF) }).strict(), annotations: BROWSER,
    },
    run: ({ site, ref }) => explore.click({ site, ref }),
  },
  {
    name: 'explore_type',
    config: {
      title: 'Type into an aria ref',
      description: 'Fill a non-credential field and optionally press Enter. Never use this for passwords or login forms; sessions are created manually with the CLI.',
      inputSchema: z.object({ site: originSchema, ref: z.string().regex(REF), text: z.string().max(10000), submit: z.boolean().default(false) }).strict(),
      annotations: BROWSER,
    },
    run: ({ site, ref, text, submit }) => explore.type({ site, ref, text, submit }),
  },
  {
    name: 'explore_snapshot',
    config: {
      title: 'Read the page snapshot',
      description: 'Read the current aria snapshot, optionally filtered by a regular expression.',
      inputSchema: z.object({ site: originSchema, grep: z.string().max(200).optional() }).strict(), annotations: READ,
    },
    run: ({ site, grep }) => explore.snapshot({ site, grep }),
  },
  {
    name: 'explore_requests',
    config: {
      title: 'Read recorded requests',
      description: 'Read requests recorded by the explore daemon after a cursor. Sensitive fields are redacted by the recorder.',
      inputSchema: z.object({ site: originSchema, since: z.number().int().nonnegative().default(0) }).strict(), annotations: READ,
    },
    run: ({ site, since }) => explore.requests({ site, since: String(since) }),
  },
  {
    name: 'explore_status',
    config: {
      title: 'Read explore status',
      description: 'Report whether the explore daemon is running, its budget, and the open mark.',
      inputSchema: siteOnly, annotations: READ,
    },
    run: ({ site }) => explore.status({ site }),
  },
  {
    name: 'explore_stop',
    config: {
      title: 'Stop the explore daemon',
      description: 'Stop the explore daemon for one site. Forced process killing is deliberately unavailable.',
      inputSchema: siteOnly, annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    run: ({ site }) => explore.stop({ site }),
  },
  {
    name: 'mark_begin',
    config: {
      title: 'Begin a demonstration',
      description: 'Start recording a train or eval demonstration for a declared tool. Inputs are string values supplied by the caller.',
      inputSchema: z.object({
        site: originSchema, tool: z.string().regex(TOOL),
        input: z.record(z.string(), z.string().trim().min(1).max(120)), role: z.enum(['train', 'eval']),
      }).strict().refine(value => Object.keys(value.input).length > 0, { message: 'input must not be empty' }),
      annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    run: ({ site, tool, input, role }) => explore.mark({ site, phase: 'begin', tool, input: JSON.stringify(input), role }),
  },
  {
    name: 'mark_end',
    config: {
      title: 'End a demonstration',
      description: 'Stop the open demonstration and record the requests observed while it was open.',
      inputSchema: siteOnly, annotations: { ...LOCAL_WRITE, idempotentHint: true },
    },
    run: ({ site }) => explore.mark({ site, phase: 'end' }),
  },
  {
    name: 'marks_list',
    config: {
      title: 'List demonstrations',
      description: 'List recorded demonstrations and the currently open mark.',
      inputSchema: siteOnly, annotations: READ,
    },
    run: ({ site }) => explore.marks({ site }),
  },
  {
    name: 'propose_tools',
    config: {
      title: 'Compile proposed tools',
      description: 'Compile recorded demonstrations into proposed recipes and verify them. This never approves a tool; human review stays in the CLI.',
      inputSchema: siteOnly, annotations: BROWSER,
    },
    run: ({ site }) => propose({ site }),
  },
  {
    name: 'site_status',
    config: {
      title: 'Read site status',
      description: 'Summarize a declared or compiled site: tools, effects, verification and review state. Recipes and response data are not returned.',
      inputSchema: siteOnly, annotations: READ,
    },
    run: siteStatus,
  },
];

function ok(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function fail(error) {
  if (!(error instanceof WorkflowError)) return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'INTERNAL_ERROR' }) }] };
  const details = Object.fromEntries(Object.entries(error).filter(([key]) => !['name', 'message', 'stack', 'code', 'status'].includes(key)));
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.code, ...redact(details) }) }] };
}

export function createFactoryServer() {
  const server = new McpServer({ name: 'anyweb-factory', version: '1.0.0' }, {
    instructions: 'AnyWeb factory control. It does not log in, approve tools, confirm writes, package bundles, or run shell commands. Never pass credentials; create sessions with the CLI. Non-GET requests are blocked; GET may still have side effects.',
  });
  for (const tool of tools) {
    server.registerTool(tool.name, tool.config, async input => {
      try { return ok(await tool.run(input)); }
      catch (error) { return fail(error); }
    });
  }
  return server;
}

export function serveFactory() {
  return serveStdio(() => createFactoryServer());
}
