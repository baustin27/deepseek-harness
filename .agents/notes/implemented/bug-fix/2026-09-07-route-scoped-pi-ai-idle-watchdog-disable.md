# Agent Note: Route-scoped pi-ai idle watchdog disable

Status: implemented

English | [中文](2026-09-07-route-scoped-pi-ai-idle-watchdog-disable.zh.md)

## Problem

The pi-ai adapter cancelled an OpenCode Zen stream after five minutes without a yielded Harness chunk. Atlas may rotate a stalled Zen proxy before it can resume the same request, so the adapter could terminate a request while the route's upstream recovery remained in progress.

## Decision

`PiAiProviderProfile.streamIdleTimeoutMs` accepts `false` in addition to a positive timeout. `streamIdleTimeoutByModel` selects that setting for one configured model without changing sibling models. A resolved `false` skips `idleWatchdog`, preserves the caller abort signal as the request lifetime control, and leaves the stream's normal provider error handling unchanged.

The Atlas route selects `false` only for `muse-spark-1.3-contributor-free`. Other models retain the 300,000 ms default or an explicitly configured positive timeout.

## Alternatives considered

- **Increasing the global timeout.** A larger global interval delays detection of genuinely stalled providers that do not have Atlas's proxy recovery.
- **Making Atlas emit synthetic chunks.** Transport recovery is not model output; manufacturing chunks would corrupt the stream protocol and reset unrelated consumer policy.
- **Disabling the watchdog for every pi-ai route.** Routes without coordinated upstream recovery still need the adapter-owned idle bound.

## Consequences

Zen requests can remain pending through Atlas's pre-output proxy rotations until caller cancellation or an upstream result. They no longer receive an adapter-generated `TIMEOUT` solely because no pi-ai chunk reached the Harness for five minutes. A disabled route needs a caller-owned deadline when its product needs a finite request lifetime.

## Testing

The pi-ai adapter test mounts a route with `streamIdleTimeoutMs: false`, waits longer than the short watchdog interval used by the neighboring timeout test, and receives the completed response. Resolver coverage pins that `false` survives profile resolution.
