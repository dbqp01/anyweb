#!/usr/bin/env node
import { Command } from 'commander';
import * as explore from './commands/explore.mjs';
import * as session from './commands/session.mjs';
import { propose } from './commands/propose.mjs';
import { initSite } from './commands/init.mjs';
import { review } from './commands/review.mjs';
import { packageSite } from './commands/package.mjs';

const program = new Command();
program.name('anyweb').description('AnyWeb MCP — Websites & web services to MCP').version('1.0.0');

const exploreCommand = program.command('explore').description('Drive a persistent Chromium session');
exploreCommand.command('start').description('Start the explore daemon')
  .requiredOption('--site <origin>').requiredOption('--start-url <url>')
  .option('--headed').option('--session <name>').option('--budget-actions <n>').option('--budget-minutes <n>')
  .action(options => run(() => explore.start(options)));
exploreCommand.command('open').description('Open a URL on the site')
  .requiredOption('--site <origin>').requiredOption('--url <url>')
  .action(options => run(() => explore.open(options)));
exploreCommand.command('click').description('Click an aria ref from the last snapshot')
  .requiredOption('--site <origin>').requiredOption('--ref <ref>')
  .action(options => run(() => explore.click(options)));
exploreCommand.command('type').description('Fill an aria ref, optionally pressing Enter')
  .requiredOption('--site <origin>').requiredOption('--ref <ref>').requiredOption('--text <text>')
  .option('--submit')
  .action(options => run(() => explore.type(options)));
exploreCommand.command('press').description('Press a keyboard key')
  .requiredOption('--site <origin>').requiredOption('--key <key>')
  .action(options => run(() => explore.press(options)));
exploreCommand.command('snapshot').description('Read the current aria snapshot')
  .requiredOption('--site <origin>').option('--grep <regex>', 'only matching lines')
  .action(options => run(() => explore.snapshot(options)));
exploreCommand.command('requests').description('Read recorded requests')
  .requiredOption('--site <origin>').option('--since <n>', 'cursor', '0')
  .action(options => run(() => explore.requests(options)));
exploreCommand.command('screenshot').description('Save a PNG of the current page')
  .requiredOption('--site <origin>')
  .action(options => run(() => explore.screenshot(options)));
exploreCommand.command('mark').description('Mark a demonstration (begin or end)')
  .argument('[phase]', 'begin or end', 'begin')
  .requiredOption('--site <origin>').option('--tool <id>').option('--input <json>').option('--role <train|eval>')
  .action((phase, options) => run(() => explore.mark({ ...options, phase })));
exploreCommand.command('marks').description('List recorded demonstrations')
  .requiredOption('--site <origin>').option('--reset', 'discard all recorded demonstrations')
  .action(options => run(() => explore.marks(options)));
exploreCommand.command('confirm').description('Allow one blocked destructive request')
  .requiredOption('--site <origin>').requiredOption('--nonce <nonce>')
  .action(options => run(() => explore.confirm(options)));
exploreCommand.command('status').description('Read daemon status')
  .requiredOption('--site <origin>')
  .action(options => run(() => explore.status(options)));
exploreCommand.command('stop').description('Stop the explore daemon')
  .requiredOption('--site <origin>').option('--force')
  .action(options => run(() => explore.stop(options)));

const sessionCommand = program.command('session').description('Manage the saved browser login');
sessionCommand.command('login').description('Log in once in a visible browser and save the storage state')
  .requiredOption('--site <origin>').option('--session <name>', 'session name', 'default').option('--start-url <url>')
  .action(options => run(() => session.login(options)));
sessionCommand.command('status').description('Report whether a saved session exists')
  .requiredOption('--site <origin>').option('--session <name>', 'session name', 'default')
  .action(options => run(() => session.status(options)));
sessionCommand.command('clear').description('Delete the saved session')
  .requiredOption('--site <origin>').option('--session <name>', 'session name', 'default')
  .action(options => run(() => session.clear(options)));

program.command('mcp').description('Start the AnyWeb factory MCP server over stdio')
  .action(async () => (await import('./mcp/factory.mjs')).serveFactory());

program.command('init').description('Import a validated site declaration without overwriting existing work')
  .requiredOption('--file <path>', 'JSON declaration with origin and tools')
  .action(options => run(() => initSite(options)));

program.command('propose').description('Compile marked demonstrations into recipes')
  .requiredOption('--site <origin>').option('--json')
  .action(options => run(() => propose(options)));
program.command('review').description('Execute proposed tools and approve or reject them')
  .requiredOption('--site <origin>').option('--input <json>').option('--yes').option('--json')
  .action(options => run(() => review(options)));
program.command('package').description('Package approved HTTP or learned browser tools as an MCP server')
  .requiredOption('--site <origin>').option('--json')
  .action(options => run(() => packageSite(options)));

async function run(task) {
  let payload;
  try {
    const result = await task();
    if (result !== undefined) payload = `${JSON.stringify(result)}\n`;
  } catch (error) {
    const details = Object.fromEntries(Object.entries(error).filter(([key]) => !['name', 'message', 'stack', 'code', 'status'].includes(key)));
    payload = `${JSON.stringify({ error: error.code ?? 'ERROR', message: error.message, ...details })}\n`;
    process.exitCode = 1;
  }
  // A protocol client can leave a 60s query timer behind; a CLI must exit once its work is done.
  if (payload !== undefined) await new Promise(resolve => process.stdout.write(payload, resolve));
  process.exit(process.exitCode ?? 0);
}

await program.parseAsync(process.argv);
