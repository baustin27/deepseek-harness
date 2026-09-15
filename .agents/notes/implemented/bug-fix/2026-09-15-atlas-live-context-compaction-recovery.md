# Agent Note: Atlas live context metadata drives DSH compaction

Status: implemented

English | [中文](2026-09-15-atlas-live-context-compaction-recovery.zh.md)

## Problem

Atlas can hot-swap local lanes while DSH keeps one provider route. A static
route default can therefore overstate the active lane's context window, letting
a request reach the provider before automatic compaction. Some llama.cpp
gateways also report overflow as the short message `Context too long (400)`.

## Decision

Atlas publishes live local per-slot capacities as `contextWindow` fields in its
OpenAI model listing. External local discovery reads the serving endpoint's
`/props` (`n_ctx_slot`, then `n_ctx`) and carries that value through the local
model directory; automatic Atlas aliases use the smallest live local capacity.

The DSH pi-ai adapter refreshes Atlas automatic-alias capacity from the live
model listing with a short cache and uses it for request metadata and pi-ai's
stream overflow accounting. The generic error classifier recognizes
`context too long/large`, so the existing overflow compaction-and-retry path
handles the gateway's HTTP 400 wording.

## Alternatives considered

**Raise the DSH static default.** Rejected because it makes the failure more
likely when Atlas selects a smaller local slot.

**Hard-code Glimmer's capacity in DSH settings.** Rejected because Atlas lanes
are hot-swappable and the same route serves multiple models.

**Parse provider error text in the compaction package.** Rejected because
adapters own provider normalization; the compaction engine already routes on
the stable `CONTEXT_WINDOW_EXCEEDED` code.

## Consequences

Automatic Atlas requests may perform one cached model-list lookup per refresh
window, and aliases conservatively use the smallest live local capacity. If
live metadata is unavailable, DSH retains the configured capacity and the
existing provider error recovery remains available.

## Testing

The Atlas model-list tests verify live context publication. DSH tests verify
the `Context too long (400)` classification and live alias capacity resolution;
workspace typechecks pass. The existing DSH lifecycle test still reports its
pre-existing empty retry-code fixture failure.
