import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRecipeRunner, readWorkflowInput } from '../artifact/recipe.mjs';
import { downloadsDir } from '../artifact/site.mjs';
import { WorkflowError } from '../artifact/errors.mjs';
import { assertReviewed } from '../artifact/review-integrity.mjs';
import { readSession } from '../session.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

async function execute(site, tool, input, createRunner) {
  const session = await readSession(site.origin, tool.recipe.session);
  const runner = createRunner(tool.recipe, tool.approved_requests, {
    session, downloadDir: downloadsDir(site.origin), allowLoopback: LOOPBACK.has(new URL(site.origin).hostname),
  });
  const result = await runner(input);
  return tool.effect === 'download' ? result : { data: result.data, evidence: result.evidence };
}

// Failures only a person can clear say so, with the exact next step, so the agent stops instead of retrying.
export function handoff(error, site, tool) {
  const session = tool.recipe.session ?? 'default';
  const login = `anyweb session login --site ${site.origin} --session ${session}`;
  if (error.code === 'CHALLENGE_REQUIRED') return {
    needs_person: true,
    instruction: tool.recipe.session
      ? `${site.origin} is showing a captcha or bot check. Ask the person to run "${login}", pass the check themselves in that window, then call this tool again. Do not retry before that.`
      : `${site.origin} is showing a captcha or bot check to automated reads. This tool has no saved session, so it cannot reuse the person's browser. Tell the person; do not retry now.`,
  };
  if (error.code === 'REAUTH_REQUIRED') return {
    needs_person: true, instruction: `The saved login for ${site.origin} is missing or expired. Ask the person to run "${login}" and sign in, then call this tool again.`,
  };
  // Runners may attach their own person-facing step (the browser runner does, so HTTP bundles never name it).
  if (error.instruction) return { needs_person: true, instruction: error.instruction };
  if (error.code === 'RATE_LIMITED' && error.retryAfter !== undefined) return { retry_after_seconds: Math.ceil(error.retryAfter / 1000) };
  return {};
}

export function createServer(site, { createRunner = createRecipeRunner } = {}) {
  const server = new McpServer({ name: `anyweb-${site.name}`, version: '1.0.0' });
  for (const tool of site.tools) {
    if (tool.status !== 'approved' || tool.verification.status !== 'passed') continue;
    assertReviewed(tool);
    server.registerTool(tool.id, {
      title: tool.goal, description: tool.recipe.execution === 'browser' ? `${tool.goal} (runs a learned browser workflow)` : tool.goal, inputSchema: readWorkflowInput(tool.recipe),
      annotations: { readOnlyHint: tool.effect === 'read', destructiveHint: false, idempotentHint: tool.effect === 'read', openWorldHint: true },
    }, async input => {
      try {
        assertReviewed(tool);
        const result = await execute(site, tool, input, createRunner);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const failure = error instanceof WorkflowError
          ? { error: error.code, ...(error.step !== undefined ? { step: error.step } : {}), ...handoff(error, site, tool) }
          : { error: 'INTERNAL_ERROR' };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] };
      }
    });
  }
  return server;
}

export function serve(site, options) {
  return serveStdio(() => createServer(site, options));
}
