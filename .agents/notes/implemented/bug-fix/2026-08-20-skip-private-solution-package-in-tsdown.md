# Agent Note: Skip the private solution package in tsdown workspace builds

Status: implemented

English | [中文](2026-08-20-skip-private-solution-package-in-tsdown.zh.md)

## Problem

The repository root is a private TypeScript solution package, not a runtime package. Its host aggregate uses `noEmit: true`, and it has no `src` tree that can produce `lib/types/index.js`, `lib/types/invariant.js`, or `lib/types/startup.js`. The root tsdown configuration nevertheless supplied those paths as a host entry, so the `rc.8` build stopped before producing the workspace packages.

## Decision

The root `tsdown.config.ts` leaves `entry` undefined for the host face and empty for the client face. Because the root configuration is a workspace coordinator, tsdown skips it when it has no entry and continues with package-local configurations. The workspace list remains unchanged; each vendored, package, and CLI build keeps its own TypeScript-emitted `lib/types` inputs and tsdown output.

## Alternatives considered

**Keep the root `lib/types` entry.** Rejected because the root solution does not emit those files, so the entry can never be satisfied by the current TypeScript project layout.

**Add a root shim or duplicate CLI entry.** Rejected because it would create a misleading private runtime artifact and duplicate ownership that belongs to `apps/cli` and the package-local configs.

**Remove the repository root from the pnpm workspace.** Rejected because the root owns the build, test, gate, and package-manager scripts even though it is not a publishable runtime package.

## Consequences

The host and client library builds no longer require a fabricated root runtime entry. The root package produces no runtime artifact, while workspace packages retain their existing build outputs. A future root runtime package must add an explicit source project and an owned tsdown entry instead of relying on the solution package configuration.
