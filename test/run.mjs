// Runs the suite two files at a time inside one hidden console, so Windows opens no cmd window per test file.
import { spawn } from 'node:child_process';

const files = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...(files.length ? files : ['test/*.test.mjs'])],
  { stdio: 'inherit', windowsHide: true });
child.on('exit', (code, signal) => process.exit(signal ? 1 : code));
