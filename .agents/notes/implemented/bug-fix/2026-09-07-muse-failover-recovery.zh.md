# Agent Note: Muse 故障转移恢复

Status: implemented

[English](2026-09-07-muse-failover-recovery.md) | 中文

## Problem

显式 Muse 路由可能在 Harness 默认的五次瞬时失败重试后结束 agent 轮次。新的重试还可能重新获取同一个失败的无冷却代理，因为每一种代理范围失败都没有清除会话 affinity；同时 Atlas 较长的请求 deadline 让每次失败尝试都需要很久才能被替换。

## Decision

Harness retry policy 在 `mode: always` 中支持可选的 `retryableCodes` allowlist。Muse profile 使用 `EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`、`TIMEOUT` 与 `TRANSPORT`，因此瞬时失败可以无限重试，而永久失败仍然立即结束。当前 Muse profile 还使用 30 秒 stream-idle 时间片，使停滞的 Atlas 请求可以更快取消并替换。

Atlas 在每一种代理范围失败上清除无冷却会话 affinity，并记录每个会话的 cycle cursor。因此下一次逻辑重试会继续遍历代理库存，而不是立即重新使用失败端点；成功请求仍保留正常的 sticky affinity。

## Alternatives considered

**对所有失败永久重试。** 否决，因为格式错误的请求、缺少凭据、上下文溢出和不支持的模型无法通过再次发起网络请求恢复。

**使用非常大的有限重试次数。** 否决，因为仍然保留终止边界，并让恢复依赖任意计数器。

**把 Muse 请求切换到 Auto combo。** 否决，因为这改变了选定模型，而不是改善 Muse 的出口恢复。

**每次请求后清除全部代理 affinity。** 否决，因为健康会话会失去有用的 sticky 行为；只有代理范围失败才推进 cycle。

## Consequences

在调用方取消或插件释放之前，瞬时 Muse 失败可以持续恢复。每次尝试的 idle 恢复更快，但持续不健康的上游仍可能消耗资源，因此 allowlist 与取消行为是有意保留的保护。显式代理 cycle 状态现在会跨越同一会话内的多个 adapter 调用。

覆盖范围包括 always mode allowlist 解析、永久失败终止、无冷却 cursor 推进，以及跨逻辑请求的 adapter 恢复。Harness 聚焦测试 57/57 通过；Atlas 聚焦测试 104/104 通过。
