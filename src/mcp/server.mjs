import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRecipeRunner, readWorkflowInput } from '../artifact/recipe.mjs';
import { downloadsDir } from '../artifact/site.mjs';
import { WorkflowError } from '../artifact/errors.mjs';
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

export function createServer(site, { createRunner = createRecipeRunner } = {}) {
  const server = new McpServer({ name: `anyweb-${site.name}`, version: '1.0.0' });
  for (const tool of site.tools) {
    if (tool.status !== 'approved' || tool.verification.status !== 'passed') continue;
    server.registerTool(tool.id, {
      title: tool.goal, description: tool.recipe.execution === 'browser' ? `${tool.goal} (runs a learned browser workflow)` : tool.goal, inputSchema: readWorkflowInput(tool.recipe),
      annotations: { readOnlyHint: tool.effect === 'read', destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async input => {
      try {
        const result = await execute(site, tool, input, createRunner);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const failure = error instanceof WorkflowError
          ? { error: error.code, ...(error.step !== undefined ? { step: error.step } : {}) }
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
