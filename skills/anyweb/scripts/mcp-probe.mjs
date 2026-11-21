#!/usr/bin/env node
// Verify a generated AnyWeb MCP server from an independent stdio client.
// Usage: node skills/anyweb/scripts/mcp-probe.mjs <bundle.mjs> [tool] ['{"input":"value"}']
// Output can contain account data. Do not paste it into public reports.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [bundle, tool, rawArguments] = process.argv.slice(2);
if (!bundle) {
  console.error('usage: node skills/anyweb/scripts/mcp-probe.mjs <bundle.mjs> [tool] [json-arguments]');
  process.exit(2);
}

let client;
const timeout = setTimeout(() => {
  console.error('probe timeout after 60s');
  process.exit(1);
}, 60000);
timeout.unref();
try {
  client = new Client({ name: 'anyweb-probe', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    stderr: 'inherit',
  }));
  const listed = await client.listTools();
  const output = { tools: listed.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (tool) {
    output.call = await client.callTool({ name: tool, arguments: rawArguments ? JSON.parse(rawArguments) : {} });
  }
  console.log(JSON.stringify(output, null, 2));
  if (output.call?.isError) process.exitCode = 1;
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
}
