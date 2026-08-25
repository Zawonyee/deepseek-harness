# Agent Note: Build the Host API proxy runtime entry

Status: implemented

English | [中文](2026-08-21-build-host-apiproxy-runtime-entry.zh.md)

## Problem

The Host API proxy source and generated type declarations can advance together while its checked-in runtime entry remains stale. In that state, `host.describe` can omit a field required by the client schema. The Web client rejects the handshake before it starts the session and workspace list calls, so an existing session inventory appears empty.

## Decision

`packages/host/apiproxy/tsdown.config.ts` defines the Node runtime entries for `lib/types/index.js` and `lib/types/invariant.js`, writing them to `lib` without cleaning the generated type tree. The workspace Host build now rebuilds the API proxy runtime after TypeScript emits its `lib/types` inputs. The generated `host.describe` implementation includes the required `home` field, keeping the runtime response aligned with `host.schema.ts` and the client handshake contract.

## Alternatives considered

**Rebuild only with TypeScript.** Rejected because TypeScript emits declarations and intermediate JavaScript under `lib/types`, but it does not produce the package's public `lib/index.js` runtime entry.

**Patch the generated runtime file manually.** Rejected because the fix would be lost on the next build and would leave the package without a reproducible runtime build definition.

**Make `home` optional in the client schema.** Rejected because the field is part of the current Host API contract; weakening validation would hide source/runtime drift instead of fixing it.

## Consequences

The Host API proxy has an explicit, reproducible Node bundle step and its runtime entry stays synchronized with the generated Host API types. Host builds perform a small additional bundle for this package. A stale artifact produced before this decision still requires rebuilding before it can serve the corrected handshake response.
