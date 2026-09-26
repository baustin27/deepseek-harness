/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/** One browser-safe method offered by an authorization flow. */
export interface AuthorizationMethodView {
  readonly id: string
  readonly label: string
}

/** One browser-safe view of a host authorization flow. */
export interface AuthorizationFlowView {
  /** The credential record addressed by this flow. */
  readonly key: string
  /** Human-facing name of the provider or account. */
  readonly label: string
  /** Methods the flow can run, in preference order. */
  readonly methods: readonly AuthorizationMethodView[]
  /** Whether the host credential store currently contains a grant. */
  readonly configured: boolean
  /** Whether another attempt for this key is currently running. */
  readonly inFlight: boolean
}

/** A browser-safe select option for an authorization prompt. */
export interface AuthorizationPromptOptionView {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** A prompt frame with all host-only cancellation signals removed. */
export type AuthorizationPromptView = {
  readonly message: string
  readonly placeholder?: string
} & ({
  readonly kind: 'text' | 'secret'
} | {
  readonly kind: 'select'
  readonly options: readonly AuthorizationPromptOptionView[]
})

/** Frames delivered while one browser authorization attempt is running. */
export type AuthorizationFrame =
  | { readonly type: 'started'; readonly attemptId: string; readonly key: string }
  | {
    readonly type: 'notice'
    readonly notice: { readonly message: string; readonly url?: string; readonly code?: string }
  }
  | { readonly type: 'prompt'; readonly promptId: string; readonly prompt: AuthorizationPromptView }
  | { readonly type: 'settled'; readonly status: 'authorized' | 'cancelled' }
  | { readonly type: 'failed'; readonly code?: string; readonly message: string }

/** Input starting one streamed browser authorization conversation. */
export interface AuthorizationRunRequest {
  readonly key: string
  readonly method?: string
}

/** Answer to one prompt previously emitted by an authorization attempt. */
export interface AuthorizationAnswerRequest {
  readonly attemptId: string
  readonly promptId: string
  readonly value: string
}

/** Cancellation request for one authorization attempt. */
export interface AuthorizationCancelRequest {
  readonly attemptId: string
}

/** Acknowledgement for an accepted prompt answer. */
export interface AuthorizationAnswerValue {
  readonly accepted: true
}

/** Acknowledgement for a cancellation request. */
export interface AuthorizationCancelValue {
  readonly cancelled: true
}
