# Agent Note: Capability Controller V1 scripted 评估

Status: implemented

[English](2026-08-25-capability-controller-v1-scripted-evaluation.md) | 中文

## 问题

不能只根据原始工具列表比较能力可用性策略。Full 预挂载、Raw Cordis 运行时激活和 Controller Lease 获取权限的方式不同，因此，不归一化 entitlement 的比较可能会低估某种模式的暴露。基于模型的运行还会把可用性策略与采样、Provider 行为和外部故障混在一起，不适合作为唯一的可复现基线。

## 决策

[`capability-controller-eval`](../../../../scripts/capability-controller-eval/README.zh.md) 通道负责 Full、Raw Cordis 和 Controller 三种模式的固定离线 scripted 对比。它把预挂载能力、运行时激活和 Lease 统一归一化为有效 entitlement，按模型步骤精确统计工具 schema，并由同一套指标实现聚合任务 oracle、用户干预、暴露、schema churn、生命周期事件和互不重叠的 token/cache 用量。

本次基线于 2026-08-25 从仓库根目录执行，未写入结果文件：

```powershell
pnpm.cmd exec tsx scripts/capability-controller-eval/run.ts --no-write
```

该命令成功完成一次重复运行，包含七个任务，每种模式各有七个 trial。

## 记录的基线

| 模式 | 任务成功率 | 用户干预率 | 平均可见工具数 | 非必要授权率 | 高风险暴露 | 风险暴露 | Schema churn 率 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Full | 1 | 0.14286 | 5 | 0.71429 | 1 | 13 | 0 |
| Raw Cordis | 1 | 0.57143 | 9.55 | 0.53846 | 1 | 10.5 | 0.76923 |
| Controller | 1 | 0.57143 | 4.52381 | 0 | 0.375 | 2.5 | 0.71429 |

| 模式 | 激活 | 复用 | 撤销 | 过期 | 拒绝 |
|---|---:|---:|---:|---:|---:|
| Full | 0 | 0 | 0 | 0 | 1 |
| Raw Cordis | 6 | 1 | 4 | 0 | 1 |
| Controller | 6 | 1 | 4 | 0 | 1 |

| 模式 | 输入 token | 输出 token | Cache-read token | Cache-write token | 总 token | 已报告 / 未报告步骤 |
|---|---:|---:|---:|---:|---:|---:|
| Full | 1,610 | 142 | 70 | 0 | 1,822 | 13 / 0 |
| Raw Cordis | 3,735 | 292 | 90 | 0 | 4,117 | 20 / 0 |
| Controller | 2,393 | 208 | 90 | 0 | 2,691 | 21 / 0 |

## 任务语料

- `doc-only` 不使用可选能力。
- `web-single` 需要一次 web 搜索。
- `web-reuse-two-turns` 在两个 turn 中复用 web 搜索。
- `email-allowed` 发送一条已批准的 outbox 消息。
- `email-rejected` 遵守拒绝结果，不产生 outbox 调用。
- `shell-workspace` 在能力获批后运行受工作区约束的 shell fixture。
- `web-then-email` 组合 web 搜索与一条已批准的 outbox 消息。

Registry miss 仍属于安全测试，而不是 headline 任务。Email Provider 是确定性 outbox fixture；shell Provider 是确定性 workspace fixture，不会执行操作系统命令，也不会把能力审批当作 sandbox escalation 审批。

## 复现与联网入口

Scripted 命令是提交到仓库的基线入口。省略 `--no-write` 时，结果只写入 `.cache/capability-controller-eval/results/`；这些结果不会提交。组装后的 Loader runner 默认使用无需密钥的 replay engine，可通过 `pnpm.cmd run eval:capability-controller --no-write` 执行。

联网运行必须显式指定，并记录 provider、model、重复次数和 seed：

```powershell
pnpm.cmd run eval:capability-controller --engine real --provider deepseek-official --model deepseek-v4-flash --repeat 3 --seed 42 --no-write
```

当前 DeepSeek adapter 不公开 provider sampling-seed 参数，因此 seed 只是 benchmark metadata。Real-engine 观察结果可以缺少 usage；持久化运行需要用显式 `--output` 写到 `.cache/capability-controller-eval/results/` 下，不能替换 scripted 基线。

## 曾考虑的替代方案

**只使用组装后的 Loader replay 作为基线。** Loader replay 是有价值的集成证据，但它会把指标回归检查与 package 构建、Loader 启动和 AgentLoop 行为耦合。归一化 scripted 通道让公式和 golden 语料可以独立复现，Loader 测试则覆盖组装路径。

**把 real-engine 测量结果作为 golden 结果提交。** 联网响应会随模型和 Provider 行为变化，需要凭据，还可能因能力策略以外的原因失败。Real run 保持为带显式输入的可选观察结果，而不是确定性通过或失败证据的来源。

**比较可见工具数而不归一化 entitlement。** 这会从分母中漏掉 Full 的启动权限或 Raw Cordis 的 critical runtime controls，使较低的暴露分数成为表示方式造成的假象。有效 entitlement 会以相同方式统计三种权限获取机制。

## 后果

基线表明 scripted 任务成功率相同时，Controller 暴露的工具少于 Full 和 Raw Cordis，没有非必要授权，并把风险暴露从 13 和 10.5 分别降低到 2.5。Web 复用贡献一次激活和一次复用，且没有为仅文档任务授予可选能力。

这些数据验证的是固定 fixture、归一化和聚合路径，不能证明真实模型的任务质量、实际 prompt-schema token 成本、Provider 可靠性、操作系统 sandbox 行为或延迟。对这些属性作出结论，需要分别记录 engine、provider、model、重复次数、seed 和结果目录的重复组装运行或联网运行。
