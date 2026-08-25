# Agent Note: 构建 Host API proxy 运行时入口

Status: implemented

[English](2026-08-21-build-host-apiproxy-runtime-entry.md) | 中文

## 问题

Host API proxy 的源码和生成类型声明可能已经一起更新，但其已生成的运行时入口仍然过期。此时，`host.describe` 可能缺少客户端 schema 要求的字段。Web 客户端会在开始请求会话列表和工作区列表之前拒绝握手，因此已有的会话清单会显示为空。

## 决策

`packages/host/apiproxy/tsdown.config.ts` 定义了 `lib/types/index.js` 和 `lib/types/invariant.js` 的 Node 运行时入口，并将它们输出到 `lib`，同时不清理生成的类型目录。Host workspace 构建会在 TypeScript 生成 `lib/types` 输入后重新构建 API proxy 运行时。生成的 `host.describe` 实现包含必需的 `home` 字段，使运行时响应与 `host.schema.ts` 以及客户端握手契约保持一致。

## Alternatives considered

**只使用 TypeScript 重新构建。** 不采用，因为 TypeScript 会在 `lib/types` 下生成声明和中间 JavaScript，但不会生成包公开的 `lib/index.js` 运行时入口。

**手动修改生成的运行时文件。** 不采用，因为下一次构建就会丢失修复，而且包仍然没有可复现的运行时构建定义。

**让客户端 schema 中的 `home` 变成可选。** 不采用，因为该字段已经属于当前 Host API 契约；放宽校验只会掩盖源码与运行时产物不一致，而不是修复它。

## Consequences

Host API proxy 现在有明确且可复现的 Node 打包步骤，其运行时入口会与生成的 Host API 类型保持同步。Host 构建会为这个包额外执行一次小型 bundle。这个决策之前生成的旧产物仍然需要重新构建，才能提供修复后的握手响应。
