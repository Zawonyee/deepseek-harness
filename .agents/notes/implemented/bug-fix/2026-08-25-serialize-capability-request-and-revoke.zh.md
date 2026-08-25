# Agent Note: 串行化能力请求与撤销转换

Status: implemented

[English](2026-08-25-serialize-capability-request-and-revoke.md) | 中文

## 问题

彼此独立的 pending grant 与 pending release 索引会让重叠转换对同一个 Lease 得出不同结论。release 已开始但 Session 日志尚未提交 `revoked` 时，相同精确 Agent 与能力的请求仍可能把该 Lease 视为 active，并以 `reused: true` 返回；Runtime 随后可能在调用方使用这次 grant 前完成停用。并发 release 也可能针对终态记录重试，而不是共享第一次操作的结果。

## 决策

Controller 为每个精确 Agent 与能力建立一条 FIFO 转换队列，串行执行 request、release、expiry 与生命周期对账。release 在进入队列前先把 Lease 标为 closing，因此 Prompt 组装与执行会在排空 in-flight 调用期间停止暴露权限。后续 request 只在前序转换结算后决定复用或激活。同一 Lease 的并发 owner release 共享同一次停用及其结果；清理时会核对操作身份，只删除由该操作安装的 pending 项。Session 事件仍是已提交权限的权威来源；队列与 closing 标记只协调进程内工作。

## 考虑过的替代方案

**增加持久化的 `revoking` Lease 状态。** 没有采用，因为该竞态属于进程内完全停稳过程。将它持久化会增加第三种权限状态与重启恢复规则，而持久日志只需要 active 与 terminal 事实。

**在 revoke 提交前允许请求复用 active 记录。** 没有采用，因为返回的 grant 可能在调用方使用前失去对应的 Runtime 工具。

**第一次操作完成后重试并发 release。** 没有采用，因为两个调用加入的是同一个已授权转换，需要得到相同结果；重试会把后来的调用变成一次新的顺序 release。

## 后果

同一精确 Agent 与能力的转换会被串行化，同时不会阻塞无关能力或 Agent。以 Agent 为键的弱索引不会保留已 dispose 的 Agent；每次成功的物理停用最多产生一个 terminal 事件；停用或 append 失败时，权限保持隐藏且转换可重试。重启、Agent dispose、Goal、turn、TTL、Provider、Registry 与 Controller 对账都使用同一条 expiry 路径。
