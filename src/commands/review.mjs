import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { WorkflowError } from '../artifact/errors.mjs';
import { downloadsDir, loadSite, saveSite } from '../artifact/site.mjs';
import { createRecipeRunner, readWorkflowInput } from '../artifact/recipe.mjs';
import { redact, redactUrl } from '../redact.mjs';
import { readSession } from '../session.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function originOf(site) {
  let origin;
  try { origin = new URL(site).origin; } catch { throw new WorkflowError('INVALID_ORIGIN', 400); }
  if (origin !== site) throw new WorkflowError('INVALID_ORIGIN', 400);
  return origin;
}

function parseProvided(raw, tools) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new WorkflowError('INVALID_INPUT', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError('INVALID_INPUT', 400);
  const perTool = tools.length > 0 && tools.every(tool => value[tool.id] && typeof value[tool.id] === 'object' && !Array.isArray(value[tool.id]));
  if (perTool) return { value, perTool };
  if (Object.values(value).some(child => typeof child !== 'string')) {
    throw new WorkflowError('INVALID_INPUT', 400, { detail: '--input must be a flat object of strings or a map keyed by tool id' });
  }
  return { value, perTool: false };
}

function describe(tool) {
  process.stderr.write(`\n${tool.id} — ${tool.goal}\n  effect: ${tool.effect}; session: ${tool.recipe.session ?? 'none'}\n  inputs: ${tool.input_fields.join(', ')}\n`);
  if (tool.recipe.execution === 'browser') {
    process.stderr.write('  execution: browser (local Chromium required)\n');
    for (const [index, step] of tool.recipe.steps.entries()) process.stderr.write(`  ${index + 1}. ${JSON.stringify(step)}\n`);
    for (const request of tool.approved_requests) process.stderr.write(`  allow: ${request.method} ${request.origin}${request.path}\n`);
    return;
  }
  for (const [index, step] of tool.recipe.steps.entries()) process.stderr.write(`  ${index + 1}. ${step.method} ${step.origin}${step.path} (${step.response})\n`);
}

export async function review({ site: target, input, yes }, env = process.env) {
  const origin = originOf(target);
  let site = await loadSite(origin, env);
  const pending = site.tools.filter(tool => tool.status === 'proposed');
  const supplied = input === undefined ? null : parseProvided(input, site.tools);
  if (yes && pending.length && !supplied) throw new WorkflowError('INPUT_REQUIRED', 400);
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stderr });
  let reviewed = 0, approved = 0;
  try {
    for (let index = 0; index < site.tools.length; index++) {
      if (site.tools[index].status !== 'proposed') continue;
      const tool = site.tools[index];
      describe(tool);
      let candidate;
      if (supplied) candidate = supplied.perTool ? supplied.value[tool.id] : supplied.value;
      else {
        candidate = {};
        for (const field of tool.input_fields) candidate[field] = await rl.question(`${tool.id}.${field}: `);
      }
      const parsed = readWorkflowInput(tool.recipe).safeParse(candidate);
      if (!parsed.success) throw new WorkflowError('INVALID_INPUT', 400, { tool: tool.id, issues: parsed.error.issues });
      const value = parsed.data;
      const session = await readSession(origin, tool.recipe.session, env);
      const startedAt = Date.now();
      let result, failure;
      try {
        const createRunner = tool.recipe.execution === 'browser' ? (await import('../browser/runner.mjs')).createBrowserRunner : createRecipeRunner;
        result = await createRunner(tool.recipe, tool.approved_requests, {
          session, downloadDir: downloadsDir(origin), allowLoopback: LOOPBACK.has(new URL(origin).hostname),
          onStep: step => {
            if (step.action) { process.stderr.write(`  step ${step.step + 1}: ${step.action} ${redactUrl(step.url)}\n`); return; }
            process.stderr.write(`  step ${step.step + 1}: ${step.method} ${redactUrl(step.url)} -> ${step.status} (${step.content_type})\n`);
            process.stderr.write(`  ${step.preview === undefined ? `${step.bytes} bytes` : JSON.stringify(redact(step.preview)).slice(0, 2000)}\n`);
          },
        })(value);
      } catch (error) { failure = error; }
      const duration = Date.now() - startedAt;
      reviewed++;
      tool.verification.hashes.review = hash(value);
      if (failure) {
        tool.verification.status = 'failed';
        process.stderr.write(`  ${tool.id} failed after ${duration}ms: ${failure.code ?? 'ERROR'}${failure.step !== undefined ? ` (step ${failure.step + 1})` : ''}\n`);
        if (rl) {
          const answer = (await rl.question(`  reject ${tool.id}? [Y/n]: `)).trim().toLowerCase();
          if (answer !== 'n') { tool.status = 'rejected'; tool.reviewed_at = new Date().toISOString(); }
        }
      } else {
        tool.verification.status = 'passed';
        if (tool.recipe.execution === 'browser') process.stderr.write(`  result: ${JSON.stringify(redact(result.data)).slice(0, 2000)}\n`);
        process.stderr.write(`  ${tool.id} passed in ${duration}ms, ${result.evidence.steps_completed} steps\n`);
        let accept = !!yes;
        if (!yes) accept = /^(a|approve|y|yes)$/i.test((await rl.question(`  approve ${tool.id}? [a/r]: `)).trim());
        tool.status = accept ? 'approved' : 'rejected';
        tool.reviewed_at = new Date().toISOString();
        if (accept) approved++;
      }
      site = await saveSite(site, env);
    }
  } finally {
    rl?.close();
  }
  return {
    site: origin, reviewed, approved,
    tools: site.tools.map(tool => ({ id: tool.id, status: tool.status, verification: tool.verification.status, reviewed_at: tool.reviewed_at })),
  };
}
