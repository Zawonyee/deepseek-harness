# Agent Note: Build publishable workspace package entries

Status: implemented

English | [中文](2026-08-20-build-publishable-workspace-package-entries.zh.md)

## Problem
Several publishable workspace packages declared `lib/index.js` and `lib/invariant.js` as runtime exports but had no package-local tsdown configuration. The TypeScript phase generated only `lib/types`, leaving the runtime exports absent. A profile that resolved one of these packages through the installation fallback therefore failed during boot with `ERR_MODULE_NOT_FOUND`.

## Decision
The four affected packages—`@deepseek-ai/dsh-file-reference`, `@deepseek-ai/dsh-file-reference-local`, `@deepseek-ai/dsh-tool-pwsh-persistent`, and `@deepseek-ai/dsh-experimental-tool-agent-team`—each own a package-local tsdown configuration. Each configuration bundles the TypeScript-emitted root and invariant entries into the runtime paths declared by its package manifest. The configurations use the same Node ESM build settings as the other host-only packages and do not change package dependencies or profile composition.

## Alternatives considered

**Create profile-specific links to `lib/types`.** Rejected because TypeScript project output is an intermediate source plane, while package `main` and invariant exports are runtime contracts owned by the package build.

**Add a root-level special-case entry list.** Rejected because it would move package ownership into the repository coordinator and make future package additions easy to omit again.

**Bundle these modules into every consuming application.** Rejected because it would duplicate package ownership and break direct package resolution used by profiles and other workspace consumers.

## Consequences
The affected packages now produce the runtime files their manifests advertise, and the profile fallback can resolve them after a normal build. The repository carries four small, repetitive package configs, but each package now has an explicit build owner and can be validated independently. A future package with runtime exports must add its package-local tsdown configuration together with its package manifest.
