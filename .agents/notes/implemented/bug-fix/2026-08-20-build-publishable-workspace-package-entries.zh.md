# Agent Note: 构建可发布 workspace 包的运行时入口

Status: implemented

[English](2026-08-20-build-publishable-workspace-package-entries.md) | 中文

## 问题
有几个可发布 workspace 包在 manifest 中声明了 `lib/index.js` 和 `lib/invariant.js` 作为运行时导出，却没有包级 tsdown 配置。TypeScript 阶段只生成了 `lib/types`，运行时导出因此缺失。profile 通过安装目录回退依赖解析其中任意一个包时，就会在启动阶段因 `ERR_MODULE_NOT_FOUND` 失败。

## 决策
受影响的四个包——`@deepseek-ai/dsh-file-reference`、`@deepseek-ai/dsh-file-reference-local`、`@deepseek-ai/dsh-tool-pwsh-persistent` 和 `@deepseek-ai/dsh-experimental-tool-agent-team`——分别拥有包级 tsdown 配置。每份配置都将 TypeScript 生成的根入口和 invariant 入口打包到包 manifest 声明的运行时路径。配置使用其他仅 Host 包相同的 Node ESM 构建设置，不改变包依赖或 profile 组合。

## 曾考虑的替代方案

**为 profile 创建指向 `lib/types` 的专用链接。** 放弃，因为 TypeScript 项目输出是中间源代码平面，而包的 `main` 与 invariant 导出是由包构建负责的运行时契约。

**在根级配置中增加特殊入口列表。** 放弃，因为这会把包的所有权移入仓库协调器，也会让未来新增包时更容易再次遗漏。

**将这些模块打包进每个消费它们的应用。** 放弃，因为这会重复包的所有权，并破坏 profile 和其他 workspace 消费者使用的直接包解析。

## 后果
受影响的包现在会生成其 manifest 宣布的运行时文件，正常构建后 profile 回退依赖可以解析它们。仓库增加了四份小而重复的包级配置，但每个包都有了明确的构建所有者，也可以独立验证。未来拥有运行时导出的包必须在包 manifest 旁同时提供包级 tsdown 配置。
