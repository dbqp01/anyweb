# Origin isolation

Storage paths are keyed by the exact origin of a site: scheme + host + port. Two URLs that
differ in scheme or port are different sites and must never share sessions, Chromium profiles,
runs, sites or downloads.

## Why the old key was unsafe

The previous key used only the host and sanitized it:

```js
new URL(origin).host.toLowerCase().replace(/[^a-z0-9.-]/g, '_')
```

That made these pairs collide on one path:

| Origins | Old key |
| --- | --- |
| `https://localhost`, `http://localhost` | `localhost` |
| `https://a:123`, `https://a_123` | `a_123` |

Collisions could expose one origin's cookies through the other, overwrite its profile, or
serve a site artifact to the wrong origin. Host-only keys also could not distinguish a
non-default port from a hostname containing the same digits.

## New key and layout

`siteKey(origin)` is the SHA-256 hex digest of the canonical `URL.origin` (lowercased host,
default port removed, path ignored). It uses only `node:crypto`, so it is deterministic,
Windows-safe (hex, no `:`) and collision-resistant. The key includes the scheme and the full
host/port, so the pairs above get different keys.

| Data | Path under `$WEB2API_HOME` (default `~/.web2api`) |
| --- | --- |
| Site artifact | `sites/<key>/site.json` |
| Default session | `sessions/<key>.json` |
| Named session | `sessions/named/<key>/<name>.json` |
| Default profile | `profiles/<key>` |
| Named profile | `profiles/named/<key>/<name>` |
| Explore run state/log | `run/<key>.json`, `run/<key>.log` |
| Downloads | `$WEB2API_DOWNLOADS/web2api/<key>` (default `~/Downloads/web2api/<key>`) |

`siteKey` is exported for callers that need the directory name; it must not be rebuilt by hand.

## Compatibility with existing data

Old files remain on disk under their old host-only names. Nothing is moved, deleted or
rewritten by this change, and tests use temporary homes only.

### Site artifacts (`site.json`)

A site artifact contains an `origin` field, which is checked for an exact match (it is not a
cryptographic proof). `loadSite` and
`loadDeclarations` first read the new keyed path, then fall back to the legacy host-keyed
path **only when the embedded `origin` is exactly the requested origin**. A legacy file
shared by two colliding origins therefore belongs to at most the origin written inside it;
the other origin gets `SITE_NOT_FOUND` and the file is left untouched.

Reading is read-only. The next `saveSite` writes the new keyed path and leaves the legacy
file in place, so old artifacts are never destroyed. There is no bulk rewrite command.

### Sessions and profiles

Storage-state JSON and Chromium profiles contain no trustworthy origin record, so a legacy
file cannot be attributed to an origin. `readSession` does **not** fall back: it raises
`REAUTH_REQUIRED` and the user must log in again with:

```sh
anyweb session login --site https://example.com
```

The fresh state is written under the new key. The old session file and profile directory
remain untouched. `session status` and `session clear` only inspect and remove the new-keyed
paths, so they cannot report or delete a legacy artifact.

Never copy a legacy session or profile into a new key by guesswork. That is exactly the
cross-origin exposure this change prevents. Relogin is the safe migration; it is also the
only supported one for credentials.

### Run state and downloads

Run state has no origin field. A legacy run file is not reused, so an old daemon is never
adopted by an origin. Old run files, logs and download folders are preserved but become
historical only; new runs and downloads use the keyed paths.

## Verification

`test/origin-isolation.test.mjs` covers key and path separation for every helper, default
and named session read/write isolation, exact-origin site fallback, rejection of a colliding
legacy site, and preservation of unbound legacy sessions, profiles and site files.
`test/named-sessions.test.mjs` continues to cover named-session isolation and clearing.
