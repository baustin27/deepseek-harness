/**
 * Generic pi-ai-backed implementation of the Harness LLM seam.
 *
 * Each resolution produces one **immutable** snapshot — the profiles plus a
 * `Models` collection holding the `Provider` each route built — and an
 * operation captures a whole snapshot before its first `await`. A
 * configuration change builds a *new* collection rather than mutating the one
 * in use, because `Models.streamSimple()` is lazy: it resolves the provider
 * when the stream is first consumed, which is after the credential await, so a
 * mutated collection would let a request that started under one configuration
 * finish under another — or fail with a provider that no longer exists. This is
 * what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
 * way down: switching models mid-reply takes effect on the next step, never
 * inside the one in flight.
 *
 * A route naming a credential reference still resolves it through the harness
 * seam and passes it as the request's `apiKey` option, which pi-ai treats as
 * the highest-priority auth override — that is what keeps the fail-loud
 * reference semantics. Everything that override does not cover reaches pi-ai
 * through the collection's own auth: the credential store holds the records a
 * login wrote and a refresh rotates, and the auth context answers the ambient
 * questions a provider asks while resolving. Both are stable across snapshots,
 * so a configuration change rebuilds the collection without forgetting who is
 * signed in.
 *
 * @module dsh-llm-pi-ai/adapter
 */

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ResolvedPiAiProviderProfile } from './config.ts'
import { toPiContext } from './context.ts'
import { discoverModels } from './discovery.ts'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { toStreamChunks } from './stream.ts'

/** Match an Atlas live id with its configured base id across the `:free` suffix. */
function atlasLookupModelId(id: string): string {
  return id.endsWith(':free') ? id.slice(0, -5) : id
}

/** One resolution's frozen view: the profiles and the collection built from them. */
interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

/** Constructor options for {@link PiAiAdapter}: the two resolution hooks the plugin owns. */
export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile) => Promise<string | undefined>
  /**
   * How every collection this adapter builds resolves auth the request-level
   * `apiKey` override does not cover. Required rather than optional: a
   * collection built without them gets pi-ai's in-memory default store, which
   * is empty at every boot and discarded on every configuration change, so a
   * route whose only method is a login would report itself unconfigured on
   * every request no matter how often the human signed in.
   */
  auth: PiAiAuthInjection
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
  /**
   * Observe one assistant history message degrading to provider-neutral
   * conversion because its stored replay state is unusable by this build.
   */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
  /** Best-effort live capacity lookup for hot-swappable routes such as Atlas. */
  resolveLiveContext?: (provider: string, model: string, signal?: AbortSignal) => Promise<number | undefined>
}

/** The two auth injectables a pi-ai collection is built with. */
export interface PiAiAuthInjection {
  /** Durable storage for credentials pi-ai itself writes: logins, and the refreshes it runs under its own lock. */
  credentials: CredentialStore
  /** Ambient lookups a provider performs while resolving its own auth. */
  authContext: AuthContext
}

/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
  toolCall: boolean,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    ...toolCall && profile.toolCallMaxTokens === undefined ? {} : toolCall ? { maxTokens: profile.toolCallMaxTokens } : {},
    ...toolCall && profile.toolCallTemperature === undefined ? {} : toolCall ? { temperature: profile.toolCallTemperature } : {},
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

/**
 * The profile default this exact model can actually take, for DESCRIBING it.
 * A configured level the model does not support yields none rather than
 * throwing: `resolveModel` builds the model catalog, and a catalog that fails
 * takes its whole provider out of every picker — so one mis-set profile field
 * would hide every model on the route, including the ones that support the
 * level. The request path still refuses, which is where a bad configuration
 * belongs: describing what a model can do must not fail because a deployment
 * asked it for something it cannot.
 * @param model - the resolved model descriptor.
 * @param effort - the profile's configured level, if any.
 * @returns the level when this model supports it, otherwise undefined.
 */
function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * Selectable reasoning efforts for one model, or nothing at all.
 *
 * A model that carries no reasoning metadata — every hand-declared one, and
 * every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
 * supporting the single level `off`. Passing that through would offer a control
 * that cannot do what it says: `off` is translated to *omitting* the reasoning
 * option, which for such a model is byte-for-byte the same request as naming no
 * effort — so a provider whose own default is to think would keep thinking with
 * `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
 * capability is unavailable, which leaves the surface offering only the
 * provider's default.
 * @param model - the resolved model descriptor.
 * @param defaultLevel - the profile's configured effort, already validated.
 * @returns the `reasoning` field, or an empty object when none can be offered.
 */
function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(
  provider: string,
  headers: Readonly<Record<string, string>> | undefined,
  requestId: string,
  sessionId: string | undefined,
  purpose: GenerateOptions['purpose'],
  workspacePath: GenerateOptions['workspacePath'],
): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
    // Correlates a Harness stream with Atlas edge:request and hop telemetry.
    // This is transport metadata only; it never reaches the model context.
    'x-dsh-request-id': requestId,
    // Atlas uses this only at the private DSH→sandbox boundary. It is not an
    // OpenCode/provider identity header and the keyless adapter scrubs all
    // transport metadata before forwarding to an upstream model provider.
    ...(['atlas', 'atlas-sandbox'] as const).includes(provider as 'atlas' | 'atlas-sandbox') && sessionId !== undefined
      ? { 'x-dsh-session-id': sessionId }
      : {},
    ...(['atlas', 'atlas-sandbox'] as const).includes(provider as 'atlas' | 'atlas-sandbox') && purpose !== undefined
      ? { 'x-dsh-request-purpose': purpose }
      : {},
    ...(['atlas', 'atlas-sandbox'] as const).includes(provider as 'atlas' | 'atlas-sandbox') && workspacePath !== undefined
      ? { 'x-dsh-workspace-path': workspacePath }
      : {},
  }
}

/**
 * pi-ai-backed multi-provider adapter. Each operation reads the current
 * profiles, so a configuration change reaches the next request without a
 * restart; model descriptors come from the collection those profiles built.
 */
export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined
  private readonly liveContext = new Map<string, { contextWindow?: number; expiresAt: number }>()
  private readonly liveModels = new Map<string, { models: readonly Model<Api>[]; expiresAt: number }>()
  private atlasRefresh: Promise<readonly Model<Api>[]> | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    const models: MutableModels = createModels(this.config.auth)
    for (const profile of profiles.values()) {
      const live = this.liveModels.get(profile.provider)
      if (live === undefined) {
        models.setProvider(profile.piProvider)
        continue
      }
      models.setProvider({
        ...profile.piProvider,
        getModels: () => live.models,
      })
    }
    this.snapshot = { profiles, models }
    return this.snapshot
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return (async () => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const models = provider === 'atlas'
        ? await this.refreshAtlasModels(profile)
        : snapshot.models.getModels(provider)
      return models.map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })()
  }

  /** Refresh Atlas's hot-swappable model directory and make its entries routable. */
  private async refreshAtlasModels(profile: ResolvedPiAiProviderProfile): Promise<readonly Model<Api>[]> {
    const cached = this.liveModels.get(profile.provider)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.models
    if (profile.baseURL === undefined || profile.baseURL.length === 0) {
      return this.current().models.getModels(profile.provider)
    }
    const baseURL = profile.baseURL
    if (this.atlasRefresh !== undefined) return this.atlasRefresh
    this.atlasRefresh = (async () => {
      try {
        const apiKey = await this.config.resolveApiKey(profile.provider, profile)
        const discovered = await discoverModels({
          provider: profile.provider,
          baseURL,
          ...profile.api === undefined ? {} : { api: profile.api },
          ...apiKey === undefined ? {} : { apiKey },
        })
        const models = this.materializeLiveModels(profile, discovered)
        if (models.length > 0) {
          this.liveModels.set(profile.provider, { models, expiresAt: Date.now() + 15_000 })
          this.snapshot = undefined
          return models
        }
      } catch {
        // Keep the last good directory or configured fallback available during
        // a transient Atlas restart; the next refresh retries after the cache.
      }
      return cached?.models ?? this.current().models.getModels(profile.provider)
    })()
    try {
      return await this.atlasRefresh
    } finally {
      this.atlasRefresh = undefined
    }
  }

  /** Convert live listing metadata into pi-ai descriptors using the configured route as protocol template. */
  private materializeLiveModels(
    profile: ResolvedPiAiProviderProfile,
    discovered: readonly LlmDiscoveredModel[],
  ): readonly Model<Api>[] {
    const configured = profile.piProvider.getModels()
    const template = configured[0]
    if (template === undefined) return []

    // A live endpoint commonly reports only ids. Match each row to its exact
    // configured model first, then to the same id without Atlas's `:free`
    // display suffix. This keeps operator-declared capacities (notably Muse's
    // 1M context) when the endpoint omits them, while live metadata wins when
    // it is present. Unknown rows use the route defaults rather than borrowing
    // the first configured model's capacity.
    const configuredById = new Map(configured.map(model => [model.id, model]))
    const configuredByLookupId = new Map(configured.map(model => [atlasLookupModelId(model.id), model]))
    const liveModels = discovered.map((entry) => {
      const configuredModel = configuredById.get(entry.id)
        ?? configuredByLookupId.get(atlasLookupModelId(entry.id))
      const base = configuredModel ?? {
        ...template,
        contextWindow: profile.defaultContextWindow ?? template.contextWindow,
        maxTokens: profile.defaultMaxTokens ?? template.maxTokens,
        input: [...profile.defaultInput ?? template.input],
      }
      return {
        ...base,
        // Keep the configured route id when the endpoint uses the same model
        // with or without Atlas's `:free` suffix. DSH's per-model stream and
        // retry settings are keyed by that stable configured id.
        id: configuredModel?.id ?? entry.id,
        name: configuredModel?.name ?? entry.name ?? base.name ?? entry.id,
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }),
        ...(entry.inputModalities === undefined ? {} : { input: [...entry.inputModalities] }),
      }
    })
    if (profile.provider !== 'atlas') return liveModels

    // Atlas's live directory contains concrete lanes, while automatic combo
    // routes are stable gateway aliases that are resolved by Atlas itself.
    // Keep those configured aliases visible when a live refresh replaces the
    // fallback catalog, so DSH exposes both the current lanes and the combos.
    const liveIds = new Set(liveModels.map(model => model.id))
    const liveLookupIds = new Set(liveModels.map(model => atlasLookupModelId(model.id)))
    // Atlas may expose only currently healthy local lanes from /v1/models
    // while its managed sandbox lane remains routable by its stable model
    // ids. Keep the explicitly configured free sandbox entries visible so a
    // transient/partial edge catalog cannot make valid managed routes vanish
    // from DSH's selector. Direct sandbox routes remain a separate provider.
    const managedConfigured = configured.filter(model =>
      (model.id === 'auto' || model.id === 'auto-free' || model.id.endsWith(':free'))
      && !liveIds.has(model.id)
      && !liveLookupIds.has(atlasLookupModelId(model.id)),
    )
    return [...liveModels, ...managedConfigured]
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return (async () => {
      const snapshot = this.current()
      const contextWindow = await this.liveContextFor(provider, model, _signal)
      return this.modelInfo(snapshot, provider, model, contextWindow)
    })()
  }

  private modelInfo(snapshot: PiAiSnapshot, provider: string, model: string, liveContextWindow?: number): LlmResolvedModelInfo {
    const profile = this.profileOf(snapshot, provider)
    const resolvedModel = this.modelOf(snapshot, provider, model)
    const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
    // Only a cap the deployment configured is a request default; the
    // catalog's `maxTokens` sizes the model and stops there.
    const configuredMaxTokens = profile.configuredMaxTokens.get(model)
    return {
      provider,
      id: model,
      name: resolvedModel.name,
      inputModalities: [...resolvedModel.input],
      context: { contextWindow: liveContextWindow ?? resolvedModel.contextWindow },
      ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
      ...reasoningInfo(resolvedModel, defaultLevel),
    }
  }

  override async prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const snapshot = this.current()
    const contextWindow = await this.liveContextFor(provider, model, _signal)
    return Promise.resolve({
      model: this.modelInfo(snapshot, provider, model, contextWindow),
      stream: options => this.streamWithSnapshot(options, snapshot, contextWindow),
    })
  }

  private async liveContextFor(provider: string, model: string, signal?: AbortSignal): Promise<number | undefined> {
    const resolver = this.config.resolveLiveContext
    // Explicit model profiles already carry an operator-selected capacity.
    // Atlas's automatic aliases are the hot-swappable case where only the
    // live route can tell us which lane will receive the request.
    if (resolver === undefined || (provider === 'atlas' && model !== 'auto' && model !== 'auto-free')) return undefined
    const key = `${provider}\u0000${model}`
    const cached = this.liveContext.get(key)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.contextWindow
    try {
      const contextWindow = await resolver(provider, model, signal)
      this.liveContext.set(key, {
        expiresAt: Date.now() + 15_000,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      })
      return contextWindow
    } catch {
      // Live metadata is advisory; retain the configured capacity on failures.
      this.liveContext.set(key, { expiresAt: Date.now() + 5_000 })
      return undefined
    }
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithSnapshot(options, this.current())
  }

  private async * streamWithSnapshot(
    options: GenerateOptions,
    snapshot: PiAiSnapshot,
    preparedContextWindow?: number,
  ): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const profile = this.profileOf(snapshot, options.provider)
    const modelBase = this.modelOf(snapshot, options.provider, options.model)
    const liveContextWindow = preparedContextWindow ?? await this.liveContextFor(options.provider, options.model, options.signal)
    const model = liveContextWindow === undefined
      ? modelBase
      : { ...modelBase, contextWindow: liveContextWindow }
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile)
    const requestId = randomUUID()

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutByModel[model.id] ?? profile.streamIdleTimeoutMs
    const watchdog = streamIdleTimeoutMs === false
      ? undefined
      : idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')
    const streamSignal = watchdog?.signal ?? upstream

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const onReplayDegrade = (reason: string): void => {
        this.config.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
      }
      const context = attachments === undefined
        ? toPiContext(options, undefined, onReplayDegrade)
        : await toPiContext({ ...options, signal: streamSignal }, {
          attachments,
          resolveImageAccess: ref => this.config.resolveImageAccess?.(attachments, ref),
          maxRequestImageBytes: profile.maxRequestImageBytes,
          requestImagePolicy: {
            maxPixels: profile.requestImagePixelBudget,
            maxBytes: profile.requestImageMaxBytes,
          },
        }, onReplayDegrade)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey, (options.tools?.length ?? 0) > 0),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined
          ? {}
          : {
            maxTokens: (options.tools?.length ?? 0) > 0 && profile.toolCallMaxTokens !== undefined
              ? Math.min(options.maxTokens, profile.toolCallMaxTokens)
              : options.maxTokens,
          },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: streamSignal,
        // Profile headers are deployment-owned; attribution names are
        // Harness-owned and therefore win collisions.
        headers: requestHeaders(
          options.provider,
          profile.headers,
          requestId,
          options.sessionId === undefined ? undefined : String(options.sessionId),
          options.purpose,
          options.workspacePath,
        ),
      })
      const iterator = toStreamChunks(events, model.contextWindow, options.signal)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = watchdog === undefined ? await iterator.next() : await watchdog.next(iterator)
          const timeout = watchdog === undefined ? undefined : timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (watchdog !== undefined && timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error, requestId: ProviderRequestId(requestId) })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
      watchdog?.[Symbol.dispose]()
    }
  }
}
