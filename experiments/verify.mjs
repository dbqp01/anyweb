import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cases, verdict } from './oracle.mjs';
const learned = JSON.parse(await readFile('experiments/results/learned.json', 'utf8'));
const browser = JSON.parse(await readFile('experiments/results/browser-agent.json', 'utf8'));
assert.equal(learned.rows.length, 15);
assert.equal(browser.rows.length, cases.length);
assert.equal(new Set(browser.rows.map(r => r.input)).size, cases.length);
for (const entry of cases) assert.equal(learned.rows.filter(r => r.input === entry.input).length, 5);
const evaluate = rows => rows.map(row => {
  const expected = cases.find(c => c.input === row.input)?.expected;
  assert.ok(expected);
  return { input: row.input, ...verdict(expected, row.actual) };
});
const learnedResults = evaluate(learned.rows);
const browserResults = evaluate(browser.rows);
assert.ok(learnedResults.every(r => r.passed));
assert.ok(browserResults.every(r => r.passed));
assert.ok(learned.negative.passed);
assert.equal(verdict(cases[0].expected, { ...cases[0].expected, price: 999 }).passed, false);
const times = learned.rows.map(r => r.ms).sort((a,b) => a-b);
const summary = {
  learned: { correct: learnedResults.filter(r => r.passed).length, total: learnedResults.length, learning_ms: learned.learning_ms, median_ms: times[Math.floor(times.length / 2)], mean_ms: times.reduce((a,b) => a+b,0)/times.length, requests_per_execution: [...new Set(learned.rows.map(r => r.requests))] },
  browser: { correct: browserResults.filter(r => r.passed).length, total: browserResults.length, tool_operations: browser.rows.reduce((sum,r) => sum+r.tool_operations,0), blind: browser.blind, timing_ms: browser.timing_ms, cost_usd: browser.cost_usd },
  negative: learned.negative,
  consistent_corruption: learned.drift,
  speedup: null,
  conclusion: 'Fixture correctness comparison only; no measured agent latency/cost ratio or autonomous learning claim.'
};
await writeFile('experiments/results/comparison.json', JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
