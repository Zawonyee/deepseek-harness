# Agent Note: 在 tsdown workspace 构建中跳过私有 solution 包

Status: implemented

[English](2026-08-20-skip-private-solution-package-in-tsdown.md) | 中文

## 问题

仓库根目录是私有的 TypeScript solution 包，不是运行时包。它的 host 聚合项目使用 `noEmit: true`，也没有能生成 `lib/types/index.js`、`lib/types/invariant.js` 或 `lib/types/startup.js` 的 `src` 目录。但根级 tsdown 配置仍把这些路径作为 host 入口，因此 `rc.8` 构建在生成 workspace 包之前就失败了。

## 决策

根级 `tsdown.config.ts` 在 host 构建面不设置 `entry`，在 client 构建面使用空值。根配置是 workspace 协调配置；当它没有入口时，tsdown 会跳过它并继续处理包级配置。workspace 列表保持不变；每个 vendor 包、仓库包和 CLI 仍使用自己的 TypeScript `lib/types` 输入及包级 tsdown 输出。

## 曾考虑的替代方案

**保留根目录的 `lib/types` 入口。** 放弃，因为当前 TypeScript 项目布局不会为根 solution 包生成这些文件，因此该入口无法满足。

**增加根级 shim 或重复 CLI 入口。** 放弃，因为这会产生误导性的私有运行时产物，并重复本应由 `apps/cli` 和包级配置负责的所有权。

**从 pnpm workspace 中移除仓库根目录。** 放弃，因为根目录虽然不是可发布运行时包，但仍拥有构建、测试、门禁和包管理器脚本。

## 后果

host 和 client 库构建不再要求一个伪造的根运行时入口。根包不生成运行时产物，workspace 包继续使用原有构建输出。未来如果根目录需要成为运行时包，必须增加明确的源代码项目和归属清晰的 tsdown 入口，而不能依赖 solution 包配置。
