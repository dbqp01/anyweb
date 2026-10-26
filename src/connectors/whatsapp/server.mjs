import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WorkflowError } from '../../artifact/errors.mjs';
import { authDir as resolveAuthDir } from './auth.mjs';
import { createWhatsAppRunner, whatsappDefinitions, whatsappInputs } from './runner.mjs';

export function createServer(runner) {
  const server = new McpServer({ name: 'anyweb-whatsapp', version: '1.0.0' });
  for (const [name, definition] of Object.entries(whatsappDefinitions)) {
    server.registerTool(name, {
      title: definition.description,
      description: definition.description,
      inputSchema: whatsappInputs[name],
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async input => {
      try {
        const result = await runner.run(name, input);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const failure = error instanceof WorkflowError ? { error: error.code } : { error: 'INTERNAL_ERROR' };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] };
      }
    });
  }
  return server;
}

export async function serve({ runner, authDir } = {}) {
  const active = runner ?? createWhatsAppRunner({ authDir: authDir ?? resolveAuthDir() });
  await active.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    void active.close().finally(() => process.exit(0));
  });
  return serveStdio(() => createServer(active));
}
