# @deepseek-ai/dsh-capability-controller

[English](README.md) | 中文

Capability Controller 会隐藏可选的模型工具，直到某个精确 Agent 获得策略批准的 Lease。Loader 配置提供封闭的 Registry，受信 Host 插件注册 Provider；Session 日志使用 required-on-read 的 `capability/change` 事件记录每次申请、授予、使用、复用、拒绝、撤销和过期。日志是 Lease 状态的唯一真源；进程内存只保留弱引用的增量折叠状态和实时 Provider Fiber。

## Loader 配置

默认导出是兼容 Loader 的 `CapabilityController` 服务。每个 `capabilities` 配置项都必须提供 `capability`、`provider`、`risk`、`approvalRequired`、`defaultScope` 和非空的 `allowedScopes`；`idleTtlSec` 与 `expireAfterSuccessfulUse` 可选。重复的能力 id、非法值、未包含 `defaultScope` 的 `allowedScopes`、原始 `cordis_*` 工具，或 Agent 启动时 Registry 仍缺失 Provider，都会使 composition 失败。

`request_capability` 的 `requested_scope` 可省略，此时使用 Registry 配置项的默认值。申请结果只有 `granted` 或 `denied`。一个精确 Agent 对每项能力最多持有一个 active Lease；作用域和生命周期绑定相同的重复申请会复用该 Lease，且不会延长 idle 截止时间；作用域或绑定不同则返回 `lease-scope-conflict`。

固定 Provider 入口是 `@deepseek-ai/dsh-capability-controller/provider-web` 和 `@deepseek-ai/dsh-capability-controller/provider-shell`。二者都通过 Host-only 的 `ctx.capabilityController.registerProvider()` effect 注册，并且仅在授权后把工具插件挂载到 `agent.ctx` 下。Provider 名、工具名和 Prompt section 名必须唯一；Provider 不得覆盖现有工具，也不得提供两个 Controller 工具或任何 `cordis_*` 工具。外部 Provider 实现根入口导出的 `AgentScopedCapabilityProvider` 接口，并遵循相同限制。

## Lease 生命周期与执行

`turn` Lease 绑定当前轮次，在正常的 `agent/turn-stopping` 或作为兜底的持久化 `turn/end` 时过期。`task` Lease 要求当前存在非终结 Goal，并在 complete、block 或 clear 时过期；edit 和 pause 会保留 Lease。`session` 与 `persistent` Lease 随其精确 Agent 一同过期，`persistent` 明确不会跨进程重启。Idle TTL 从 grant 事件开始计算，只有真实的受控 Provider 工具产生最终 `tools/result` 后才会推进。`expireAfterSuccessfulUse` 仅在 Provider 调用成功且未取消时触发。只有显式调用 `release_capability` 才会写入 `revoked`；所有自动终结路径都写入带原因的 `expired`。

Prompt assembly 只发布由已提交且非 closing Lease 支持的受控工具与指引。执行还要求精确 owner Agent、当前 schema generation，以及相匹配且尚未结算的 `tool/call`；Code Mode 的嵌套调用还要求匹配的 dispatch 记录。释放和过期会先同步隐藏 schema 并拒绝新调用，再排空 in-flight 调用、dispose Provider Fiber，最后追加一条 terminal 事件。Deactivation 或 append 失败时会维持 fail-closed 状态以便重试，不会发布虚假的终态。

要求审批的配置项会调用 `ApprovalService.requestWithReceipt()`。只有 `allowed-once` 可以继续；`rejected`、`cancelled`、审批服务缺失和 answerer 失败都会产生稳定的 denial code。能力审批不会绕过 shell 命令自身独立的 sandbox escalation 审批。

## `controlled-doc` preset

内置 `controlled-doc` Agent preset 最初提供文档 `read`、`write` 和 `edit`，在满足条件时增加 `read_image`，并只暴露 `request_capability` 与 `release_capability` 两个能力控制工具。它通过 `provider-web` 注册需要审批的 `web.search`，使用 600 秒 TTL 的 session Lease；通过平台 shell Provider 注册需要审批的 `shell.execute`，绑定 turn，并在成功后过期。它不会登记 `email.send`，不会在授权前提供 Web 或 shell 工具，也不会提供 Goal 工具、原始 Cordis 工具，或与工具分离的 Provider 指引。

从仓库启动应用，然后在新会话的 preset 选择器中选择“受控文档模式”：

```sh
pnpm dsh
```

## 模型体验

### 动态能力控制

#### 模型可见内容

模型始终能看到 `request_capability` 和 `release_capability`。获得授权的 Provider 工具及其指引会在下一次组装的请求中首次出现，并在释放或过期后的下一次请求中消失。拒绝是紧凑的结构化工具结果，而不是执行失败。

#### Token 影响

两个控制 schema 构成稳定的基础开销。可选 Provider schema 与指引只在其已提交 Lease 可见的轮次消耗输入 token；每次生命周期工具调用会在历史中增加一条较小的 JSON 结果。

#### KV Cache 影响

授权集合不变时，请求保持相同的规范化工具 schema。Grant、release 或 expiry 会改变下一次请求的 schema，并可能使该边界之后的 cache 复用失效；精确的重复 Lease 复用不会改变 schema generation。

## 已知限制与延期工作

- V1 不会生成或晋升 Registry miss，不会安装 Marketplace Provider、重写 Agent Runtime、切换实时 preset，也不提供可视化 composition builder。
- `email.send` 只提供外部 Provider 集成接口和确定性的测试 outbox；内置 preset 不登记邮件实现。
- Persistent Lease 表示 Agent 生命周期内的策略选择，而不是可重启的权限。启动时会令日志中仍 active 的 Lease 过期，而不会重新激活其 Provider。
- Telemetry 只能观察已提交事件。Sink 失败只会告警，不能回滚或创建权限。
