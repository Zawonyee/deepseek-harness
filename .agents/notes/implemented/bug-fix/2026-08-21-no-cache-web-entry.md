# Agent Note: Do not cache the Web entry document

Status: implemented

English | [中文](2026-08-21-no-cache-web-entry.zh.md)

## Problem

The Web server's entry document selects the current hashed frontend bundles and receives the boot manifest through index taps, but it had no explicit cache policy. After a source update, a browser could reuse an older entry document and pair an old client runtime with the current Host event wire. The page still opened and unary RPCs could succeed while conversation events failed to render.

## Decision

The frontend-static fallback sends `Cache-Control: no-store` for the entry document served at `/`, `/index.html`, and SPA fallbacks. Its package-local `tsdown.config.ts` emits the runtime entry from `lib/types`, so source changes to this server are included by the workspace build. Hashed assets and dynamically served client plugin bundles keep their existing policies. The static-server test asserts the no-store policy for every entry path.

## Alternatives considered

**Leave cache behavior to browser heuristics.** Rejected because an update-sensitive entry document needs an explicit freshness guarantee; heuristic caching can preserve an incompatible client after a restart.

**Disable caching for every static asset.** Rejected because the entry document is the changing selector, while hashed assets are independently versioned and do not need the same broad policy.

**Add a manual query-string or hard-refresh requirement.** Rejected because recovery would depend on user action and would not protect normal Web restarts or automated browser launches.

## Consequences

Every Web navigation revalidates the small entry document and receives the current boot manifest. Hashed frontend assets remain cacheable according to their existing serving paths, while an already-open stale tab still needs one reload to receive the new entry.
