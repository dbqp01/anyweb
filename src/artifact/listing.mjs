// Marketplace listing for a packaged site: everything the engine already proved, plus a publisher block the
// person fills in by hand. Repackaging keeps that block, so edits survive a rebuild.
import { createHash } from 'node:crypto';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export const PUBLISHER_FIELDS = ['description', 'author', 'version', 'license', 'category'];

// TODO(owner): decide which publisher fields must be filled before a listing can be published.
// Return the names of the missing ones; an empty array means "publishable".
export function missingForPublish(publisher) {
  return [];
}

export function buildListing({ site, evidence, evidenceText, previous }) {
  const publisher = Object.fromEntries(PUBLISHER_FIELDS.map(field => [field, previous?.publisher?.[field] ?? null]));
  const missing = missingForPublish(publisher);
  return {
    listing_version: 1,
    id: `anyweb-${site.name}`,
    name: site.name,
    origin: site.origin,
    allowed_origins: site.allowed_origins,
    runtime: evidence.runtime,
    requires_session: site.session !== null,
    tools: site.tools.map(tool => ({
      id: tool.id, goal: tool.goal, effect: tool.effect, execution: tool.recipe.execution ?? 'http', input_fields: tool.input_fields,
      verification: { training: tool.verification.training, held_out: tool.verification.held_out },
    })),
    integrity: { bundle_sha256: evidence.bundle.sha256, evidence_sha256: sha256(evidenceText), engine_hash: evidence.engine_hash },
    generated_at: evidence.generated_at,
    publisher,
    publishable: missing.length === 0,
    missing,
  };
}
