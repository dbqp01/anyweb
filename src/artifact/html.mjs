import { z } from 'zod';
import { load } from 'cheerio';
import { parse } from './errors.mjs';

const key = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/).refine(s => !['__proto__', 'prototype', 'constructor'].includes(s));
const selector = z.string().trim().min(1).max(300);
const attribute = z.string().regex(/^[a-zA-Z_:][-a-zA-Z0-9_:.]{0,99}$/);
const MAX_VALUE = 2000;
const MAX_ROWS = 250;

const fieldSchema = z.object({
  selector: selector.optional(),
  attr: attribute.optional(),
  absolute: z.boolean().default(false),
}).strict().superRefine((field, ctx) => {
  if (field.absolute && !field.attr) ctx.addIssue({ code: 'custom', message: 'absolute needs an attribute' });
});

export const extractSchema = z.object({
  mode: z.enum(['list', 'object']),
  root: selector,
  fields: z.record(key, fieldSchema).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 30, 'fields must have 1..30 entries'),
  // Rows missing these fields are banners or empty slots, not results.
  require: z.array(key).max(8).default([]),
  unique: key.nullable().default(null),
}).strict().superRefine((spec, ctx) => {
  for (const field of [...spec.require, ...(spec.unique ? [spec.unique] : [])]) if (!Object.hasOwn(spec.fields, field)) ctx.addIssue({ code: 'custom', message: `field ${field} is not extracted` });
  if (spec.mode === 'object' && (spec.require.length || spec.unique)) ctx.addIssue({ code: 'custom', message: 'require and unique only apply to list mode' });
});

function valueOf($, element, field, baseUrl) {
  const target = field.selector ? $(element).find(field.selector).first() : $(element);
  if (!target.length) return null;
  let value;
  if (field.attr) {
    const raw = target.attr(field.attr);
    if (raw === undefined) return null;
    value = raw.trim();
    if (field.absolute) {
      try {
        const url = new URL(value, baseUrl);
        value = ['http:', 'https:'].includes(url.protocol) ? url.href : '';
      } catch { value = ''; }
    }
  } else {
    value = target.text().replace(/\s+/g, ' ').trim();
  }
  return value.slice(0, MAX_VALUE) || null;
}

// Declarative extraction from a recorded HTML response; the output feeds the same shape/checks as JSON.
export function extractHtml(html, baseUrl, rawSpec) {
  const spec = parse(extractSchema, rawSpec, 'INVALID_EXTRACTION');
  const $ = load(html);
  if (spec.mode === 'object') {
    const root = $(spec.root).first();
    if (!root.length) return null;
    return Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, valueOf($, root, field, baseUrl)]));
  }
  // The recipe check model addresses collections by path; wrap rows so `items` is that path.
  const rows = $(spec.root).toArray().slice(0, MAX_ROWS)
    .map(element => Object.fromEntries(Object.entries(spec.fields).map(([name, field]) => [name, valueOf($, element, field, baseUrl)])));
  const kept = spec.require.length ? rows.filter(row => spec.require.every(field => row[field] !== null)) : rows;
  return { items: spec.unique ? [...new Map(kept.map(row => [row[spec.unique], row])).values()] : kept };
}
