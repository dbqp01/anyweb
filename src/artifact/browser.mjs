import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { extractSchema } from './html.mjs';
import { parse, WorkflowError } from './errors.mjs';
import { redactUrl } from '../redact.mjs';

const field = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
const binding = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal('input'), field }).strict(),
]);
const locator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('css'), value: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal('label'), name: binding }).strict(),
  z.object({ kind: z.literal('role'), role: z.enum(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'tab']), name: binding }).strict(),
]);
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), url: z.url() }).strict(),
  z.object({ action: z.literal('click'), locator }).strict(),
  z.object({ action: z.literal('type'), locator, text: binding, submit: z.boolean() }).strict(),
  z.object({ action: z.literal('press'), key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space']) }).strict(),
]);

export const browserRecipeSchema = z.object({
  version: z.literal(1), execution: z.literal('browser'), id: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/),
  effect: z.literal('read'), input_fields: z.array(field).min(1).max(8),
  session: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).nullable(),
  steps: z.array(action).min(1).max(32), extract: extractSchema,
  required_fields: z.array(field).min(1).max(30),
  checks: z.array(z.object({ input: field, fields: z.array(field).min(1).max(30) }).strict()).min(1).max(8),
  observed_at: z.iso.datetime(), discovery: z.literal('demonstration_guided_browser_inference'),
}).strict().superRefine((recipe, ctx) => {
  const issue = message => ctx.addIssue({ code: 'custom', message });
  if (recipe.steps[0].action !== 'open') issue('browser demonstrations must start with open');
  if (new Set(recipe.input_fields).size !== recipe.input_fields.length) issue('inputs must be unique');
  if (recipe.required_fields.some(field => !Object.hasOwn(recipe.extract.fields, field))) issue('unknown required output field');
  if (recipe.checks.length !== recipe.input_fields.length || new Set(recipe.checks.map(check => check.input)).size !== recipe.input_fields.length) issue('every input needs a result check');
  for (const check of recipe.checks) {
    if (!recipe.input_fields.includes(check.input) || check.fields.some(name => !Object.hasOwn(recipe.extract.fields, name))) issue('unknown check field');
  }
  for (const step of recipe.steps) {
    for (const value of [step.text, step.locator?.name]) if (value?.kind === 'input' && !recipe.input_fields.includes(value.field)) issue('unknown input binding');
    if (step.action === 'open') {
      const url = new URL(step.url);
      if (url.username || url.password || redactUrl(step.url) !== url.href) issue('credentials cannot be recorded in navigation URLs');
    }
  }
});

const fail = code => { throw new WorkflowError(code, 422); };
const rowsOf = (output, extract) => extract.mode === 'list' ? output?.items : output ? [output] : [];
const contains = (value, query) => typeof value === 'string' && value.toLowerCase().includes(query.toLowerCase());

export function browserResultMatches(recipe, data, input) {
  const rows = rowsOf(data, recipe.extract);
  return Array.isArray(rows) && rows.length > 0 && rows.every(row => recipe.required_fields.every(field => typeof row[field] === 'string' && row[field].trim())) && recipe.checks.every(check =>
    rows.some(row => check.fields.some(field => contains(row[field], input[check.input]))));
}

export function compileBrowserRecipe({ id, input_fields, session, extract, marks }) {
  if (marks.length !== 2 || !extract) fail('DEMONSTRATIONS_REQUIRED');
  if (!marks[0].browser_actions?.length || marks.some(mark => mark.browser_actions?.length !== marks[0].browser_actions.length)) fail('INCONSISTENT_BROWSER_ACTIONS');
  const bind = values => {
    if (values.every(value => value === values[0])) return { kind: 'literal', value: values[0] };
    const matches = input_fields.filter(field => marks.every((mark, index) => mark.input[field] === values[index]));
    if (matches.length !== 1) fail('UNBOUND_BROWSER_VALUE');
    return { kind: 'input', field: matches[0] };
  };
  const steps = marks[0].browser_actions.map((first, index) => {
    const actions = marks.map(mark => mark.browser_actions[index]);
    if (actions.some(action => action.action !== first.action)) fail('INCONSISTENT_BROWSER_ACTIONS');
    const step = structuredClone(first);
    if (first.action === 'type') step.text = bind(actions.map(action => action.text));
    if (first.locator?.name !== undefined) step.locator.name = bind(actions.map(action => action.locator?.name));
    const fixed = action => {
      const copy = structuredClone(action);
      if (copy.action === 'type') delete copy.text;
      if (copy.locator?.name !== undefined) delete copy.locator.name;
      return copy;
    };
    if (actions.some(action => !isDeepStrictEqual(fixed(action), fixed(first)))) fail('INCONSISTENT_BROWSER_ACTIONS');
    return step;
  });
  const checks = input_fields.map(input => ({ input, fields: Object.keys(extract.fields).filter(field =>
    marks.every(mark => rowsOf(mark.browser_output, extract)?.some(row => contains(row[field], mark.input[input])))) }));
  if (checks.some(check => !check.fields.length)) fail('BROWSER_POSTCONDITION_REQUIRED');
  const bound = new Set(steps.flatMap(step => [step.text, step.locator?.name].filter(value => value?.kind === 'input').map(value => value.field)));
  if (input_fields.some(input => !bound.has(input))) fail('UNBOUND_BROWSER_INPUT');
  const required_fields = Object.keys(extract.fields).filter(field => marks.every(mark => {
    const rows = rowsOf(mark.browser_output, extract);
    return rows?.length && rows.every(row => typeof row[field] === 'string' && row[field].trim());
  }));
  return parse(browserRecipeSchema, { version: 1, execution: 'browser', id, effect: 'read', input_fields, session: session ?? null,
    steps, extract, required_fields, checks, observed_at: new Date().toISOString(), discovery: 'demonstration_guided_browser_inference' }, 'INVALID_BROWSER_RECIPE');
}
