# Agent Note: DSH refreshes Atlas's live model directory

Status: implemented

## Problem

Atlas changes its available local model IDs when GPU lanes load, unload, or swap. DSH's pi-ai adapter previously used the static `atlas` profile for `listModels()`, even though it already queried Atlas for automatic-alias context capacity. The picker therefore omitted live local models, and selecting a model returned `UNKNOWN_MODEL` because the request snapshot had never materialized that ID.

## Decision

The `atlas` route treats its OpenAI-compatible `/models` response as the live directory. `PiAiAdapter.listModels('atlas')` refreshes that directory with the route's configured credential and endpoint, retaining a short-lived cache and the last good/configured fallback during transient gateway failures. Each discovered entry is cloned from the configured Atlas model descriptor so its protocol, compatibility, authentication, and stream implementation remain unchanged while its ID, display name, and advertised capacities come from Atlas.

The adapter invalidates its immutable request snapshot after a successful refresh and registers a provider wrapper containing the discovered descriptors. This keeps the existing per-call snapshot guarantee while allowing the next selected model to route through the same Atlas endpoint. Other providers continue to use their installed or configured catalogs without network refreshes.

## Consequences

The Atlas picker reflects the live directory whenever DSH reads the model catalog, with a fifteen-second cache. A temporary Atlas restart does not erase the previous usable list. A listing with no materializable configured descriptor falls back to the configured route rather than inventing an incomplete pi-ai model.

## Verification

The focused Atlas adapter test verifies that a live model is listed and then routed successfully through `/models` and `/chat/completions`. Repository typecheck and host build completed. The full adapter file still contains an unrelated existing lifecycle-fixture failure caused by an empty `retryableCodes` configuration.
