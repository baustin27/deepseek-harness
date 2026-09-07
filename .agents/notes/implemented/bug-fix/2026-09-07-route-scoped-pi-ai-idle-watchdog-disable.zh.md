# Agent Note: 按路由禁用 pi-ai 空闲看门狗

Status: implemented

English | [中文](2026-09-07-route-scoped-pi-ai-idle-watchdog-disable.md)

## Problem

pi-ai 适配器会在五分钟未产出 Harness 分片后取消 OpenCode Zen 流。Atlas 可以在继续同一请求前轮换停滞的 Zen 代理，因此适配器可能在该路由的上游恢复仍在进行时终止请求。

## Decision

`PiAiProviderProfile.streamIdleTimeoutMs` 除正超时外还接受 `false`。`streamIdleTimeoutByModel` 会为一个已配置模型选择该设置，而不改变同路由的其他模型。解析后的 `false` 会跳过 `idleWatchdog`，保留调用方 abort signal 作为请求生命周期控制，并保持流原有的提供方错误处理。

Atlas 路由只为 `muse-spark-1.3-contributor-free` 选择 `false`。其他模型保留 300,000 ms 默认值或显式配置的正超时。

## Alternatives considered

- **增大全局超时。** 更大的全局间隔会延迟发现没有 Atlas 代理恢复能力的真实停滞提供方。
- **让 Atlas 产出合成分片。** 传输恢复不是模型输出；制造分片会破坏流协议，并重置无关的消费者策略。
- **为所有 pi-ai 路由禁用看门狗。** 没有协调上游恢复的路由仍需要适配器拥有的空闲上限。

## Consequences

Zen 请求可以在 Atlas 的输出前代理轮换期间保持 pending，直到调用方取消或上游给出结果。它们不会仅因五分钟内没有 pi-ai 分片到达 Harness 而收到适配器生成的 `TIMEOUT`。禁用后的路由在产品需要有限请求生命周期时必须由调用方拥有 deadline。

## Testing

pi-ai 适配器测试以 `streamIdleTimeoutMs: false` 挂载路由，等待超过相邻超时测试所用的短看门狗间隔后接收完成响应。解析器覆盖固定 `false` 会在 profile 解析后保留。
