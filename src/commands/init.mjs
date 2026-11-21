import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { draftSiteSchema, loadDeclarations, siteDir, siteFile } from '../artifact/site.mjs';
import { parse, WorkflowError } from '../artifact/errors.mjs';

export async function initSite({ file }, env = process.env) {
  let raw;
  try { raw = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new WorkflowError('DECLARATION_NOT_FOUND', 404);
    if (error instanceof SyntaxError) throw new WorkflowError('INVALID_DECLARATION_JSON', 400);
    throw error;
  }
  const site = parse(draftSiteSchema, raw);
  for (const tool of site.tools) {
    if (new Set(tool.input_fields).size !== tool.input_fields.length) {
      throw new WorkflowError('INVALID_INPUT', 400, { tool: tool.id, detail: 'input_fields must be unique' });
    }
  }
  try {
    await loadDeclarations(site.origin, env);
    throw new WorkflowError('SITE_ALREADY_EXISTS', 409, { site: site.origin, detail: 'Existing declaration preserved' });
  } catch (error) {
    if (error.code !== 'SITE_NOT_FOUND') throw error;
  }
  const target = siteFile(site.origin, env);
  await mkdir(siteDir(site.origin, env), { recursive: true });
  try { await writeFile(target, `${JSON.stringify(site, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new WorkflowError('SITE_ALREADY_EXISTS', 409, { site: site.origin, detail: 'Existing declaration preserved' });
    throw error;
  }
  return { site: site.origin, file: target, tools: site.tools.map(tool => tool.id), next: 'explore start' };
}
