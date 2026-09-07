# Agent Note: Muse failover recovery

Status: implemented

English | [中文](2026-09-07-muse-failover-recovery.zh.md)

## Problem

An explicit Muse route could stop an agent turn after the Harness's default five transient retries. A new retry could also reacquire the same failed no-cooldown proxy because session affinity was not cleared for every proxy-scoped failure, and long Atlas request deadlines made each failed attempt slow to replace.

## Decision

The Harness retry policy supports an optional `retryableCodes` allowlist in `mode: always`. The Muse profile uses `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `TIMEOUT`, and `TRANSPORT`, so transient failures retry without an attempt limit while permanent failures remain terminal. The live Muse profile also uses a 30-second stream-idle slice so a stalled Atlas request is cancelled and replaced sooner.

Atlas clears no-cooldown session affinity on every proxy-scoped failure and records a per-session cycle cursor. The next logical retry therefore advances through the proxy inventory instead of immediately reusing the failed endpoint, while successful requests retain normal sticky affinity.

## Alternatives considered

**Keep retrying every failure forever.** Rejected because malformed requests, missing credentials, context overflow, and unsupported models cannot recover through another network attempt.

**Use a very large finite retry count.** Rejected because it retains a terminal edge and makes recovery depend on an arbitrary counter.

**Switch Muse requests to the Auto combo.** Rejected because that changes the selected model rather than improving Muse's egress recovery.

**Clear all proxy affinity after every request.** Rejected because healthy sessions lose useful stickiness; only proxy-scoped failures advance the cycle.

## Consequences

Transient Muse failures remain recoverable indefinitely until caller cancellation or plugin disposal. Per-attempt idle recovery is faster, but a persistently unhealthy upstream can still consume resources, so the allowlist and cancellation behavior are intentional safeguards. Explicit proxy cycle state now survives individual adapter calls within a session.

Coverage includes always-mode allowlist resolution, terminal permanent failures, no-cooldown cursor progression, and adapter recovery across logical requests. Focused Harness tests pass 57/57; focused Atlas tests pass 104/104.
