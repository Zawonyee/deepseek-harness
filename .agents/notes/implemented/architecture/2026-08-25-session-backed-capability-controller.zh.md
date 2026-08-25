# Agent Note: 基于 Session 的能力权限

Status: implemented

[English](2026-08-25-session-backed-capability-controller.md) | 中文

## 问题

面向模型的工具代表可执行权限，而不只是 Prompt 上下文。动态增加 schema 却不持久化其所有权，会使重启和 replay 无法解释该工具为何可见；只隐藏 schema 而不限制执行，则直接 ToolRuntime 调用与 Code Mode 调用仍可绕过策略。进程级插件激活还会让一个 Agent 的授权泄漏给同级 Agent。

## 决策

`@deepseek-ai/dsh-capability-controller` 负责一个封闭的 Registry、策略判断、精确 Agent Lease 生命周期、受信 Provider 激活与执行限制。Loader 配置声明能力 id、Provider、风险、审批要求、默认和允许的作用域、idle TTL 与成功后过期。Host 插件通过一个 effect 注册 Provider descriptor；Provider 不得覆盖现有工具、占用 Controller 或 `cordis_*` 名称，也不得共享 Provider、工具或 Prompt section 的所有权。

Required-on-read 的 `capability/change` V1 Session 事件是唯一权威状态。申请从 `requested` 转换为 `denied`、新的 `granted` 或 `reused`；Lease 从 `active` 仅转换一次，成为显式 `revoked` 或自动 `expired`。时间只来自事件 envelope。`WeakMap<Session, incremental fold>` 用于加速读取，但不会成为另一个存储；进程内索引只保留 Agent 的弱所有权引用与实时 Provider Fiber。

同一个精确 Agent 与能力共用一条串行 transition queue，并且最多存在一个 active Lease。只有作用域和生命周期绑定完全相同时才能复用，且复用不会刷新 TTL；任何不一致都会被拒绝。Turn、Goal、Agent、Session、TTL、Provider、Controller、重启与 definition change 路径会汇聚到同一个 expiry 操作。Closing 会同步隐藏权限、排空 in-flight 调用、dispose 精确 Fiber，然后提交一条 terminal 事件。Deactivation 或 append 失败时维持 fail closed，并可重试。

Provider 在 `agent.ctx` 下激活。新授权会先激活 Fiber，再追加持久化 grant；append 失败会 dispose Fiber，只有已提交 Lease 才对模型可见。Prompt assembly 会过滤受控工具和 Provider 指引；权限在 snapshot 后变化时，`agent/pre-step` 会重新组装；工具执行则要求精确 owner、已提交且非 closing 的 Lease、当前 schema generation，以及匹配且尚未结算的调用记录。Code Mode 嵌套调用还需要其 dispatch 记录。日志中的 active Lease 不会在进程重启后重新激活；reconciliation 会将其作为已丢失的进程内权限令其过期。

内置 `controlled-doc` preset 展示了实际 composition：文档工具最初可用，需要审批的 `web.search` 位于 session Lease 之后，需要审批的 `shell.execute` 位于 turn Lease 之后，并在一次成功调用后过期。Shell 能力审批与命令级 sandbox escalation 审批相互独立。

## 考虑过的替代方案

**使用原始 Dynamic Cordis 激活。** 未采用，因为其 Host effect 不在精确 Agent 作用域内，其控制工具允许任意运行时修改，而且其激活记录不能建立持久化 Lease 权限。

**把 Prompt 过滤作为执行限制。** 未采用，因为直接 ToolRuntime 执行、陈旧请求 generation、同一步伪造调用与 Code Mode 嵌套调用都不需要通过当前 schema 重新发现工具。

**将 Lease 状态保存在进程内存中，并尽力恢复。** 未采用，因为 replay 和崩溃恢复会与产生历史工具调用的权限不一致。重启后重新激活日志中的 Lease 还会跳过当前策略、审批、Provider definition 与精确 Fiber 身份。

**持久化通用的 `closing` 状态。** 未采用，因为 closing 是进程内的完全停稳过程，而不是持久化权限。日志只记录已提交的 active 与 terminal 事实；恢复时，如果 active 事实失去其 Fiber，则按 expired 处理。

## 后果

可选工具的暴露可以追溯到持久化事件，并在 schema 发现与执行中始终按精确 Agent 身份隔离。撤销需要等待 in-flight 调用排空与 Provider teardown；重启会有意丢弃 persistent-scope 权限。Provider definition 必须与 Controller 一同安装，并在一个 Lease generation 内保持稳定。Registry miss 生成、Marketplace 安装、Agent Runtime 重写、实时 preset 切换与可视化 composition 不属于 V1。

定向的生命周期、并发、HMR、replay、invariant、Provider、Loader、preset 与 scripted evaluation 测试固定了这些规则。可复现 evaluator 使用任务成功率、用户干预、可见工具数、风险暴露、schema churn、生命周期计数和 token/cache 用量，对比 Full、Raw Cordis 与 Controller composition，且不会提交 real-engine 结果。
