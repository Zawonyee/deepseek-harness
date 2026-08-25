# capability/：动态能力权限

[English](README.md) | 中文

为可选模型工具提供基于 Session 的策略、精确 Agent Lease、受信 Provider 激活与执行限制。Controller 将能力状态保存在 Session 日志中，并且仅在存在已提交权限时，才让 Provider 的工具 schema 与指引可见。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`capability-controller/`](capability-controller/README.zh.md) | Capability Registry、Lease 生命周期、Provider 激活与受控模型工具 | `ctx.capabilityController` |

该包包含 `provider-web` 和 `provider-shell` 两个 Loader 入口。应用 composition 与内置 `controlled-doc` preset 仍由 [`apps/cli`](../../apps/cli/README.zh.md) 负责。
