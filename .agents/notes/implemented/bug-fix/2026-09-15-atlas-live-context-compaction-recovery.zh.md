# Agent Note: Atlas 实时上下文元数据驱动 DSH 压缩

Status: implemented

[English](2026-09-15-atlas-live-context-compaction-recovery.md) | 中文

## Problem

Atlas 可以在同一个 DSH 提供方路由后热切换本地 lane。静态默认值可能高估
当前 lane 的上下文窗口，使请求在自动压缩前到达提供方。一些 llama.cpp
网关还会用简短的 `Context too long (400)` 报告溢出。

## Decision

Atlas 在 OpenAI 模型列表中发布本地每槽位的实时 `contextWindow`。本地外部
发现从服务端 `/props` 读取 `n_ctx_slot`（其次为 `n_ctx`），并将其带入本地
模型目录；Atlas 自动别名使用当前本地容量中的最小值。

DSH pi-ai 适配器以短缓存从实时模型列表刷新 Atlas 自动别名容量，并将该值
用于请求元数据和 pi-ai 的流溢出判断。通用错误分类器识别
`context too long/large`，因此现有的溢出压缩与重试路径可以处理网关的 HTTP 400。

## Alternatives considered

**提高 DSH 静态默认值。** 否决，因为 Atlas 选择较小本地槽位时会更容易失败。

**在 DSH 设置中硬编码 Glimmer 容量。** 否决，因为 Atlas lane 会热切换，同一路由服务多个模型。

**在压缩包中解析提供方错误文本。** 否决，因为适配器负责提供方错误规范化；压缩引擎已经根据稳定的 `CONTEXT_WINDOW_EXCEEDED` code 路由。

## Consequences

Atlas 自动请求可能在每个刷新窗口执行一次缓存的模型列表查询，别名保守地使用当前本地最小容量。如果实时元数据不可用，DSH 保留配置容量，现有的提供方错误恢复仍然可用。

## Testing

Atlas 模型列表测试验证实时上下文发布。DSH 测试验证 `Context too long (400)` 分类和自动别名容量解析；工作区类型检查通过。现有 DSH 生命周期测试仍报告其预先存在的空 retry-code fixture 失败。
