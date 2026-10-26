import { serve } from './server.mjs';
import { createRecipeRunner } from '../artifact/recipe.mjs';
import { createBrowserRunner } from '../browser/runner.mjs';
import { siteSchema } from '../artifact/site.mjs';
import { parse } from '../artifact/errors.mjs';

export function serveBrowserSite(site) {
  return serve(parse(siteSchema, site, 'INVALID_SITE'), {
    createRunner: (recipe, approved, options) => (recipe.execution === 'browser' ? createBrowserRunner : createRecipeRunner)(recipe, approved, options),
  });
}
