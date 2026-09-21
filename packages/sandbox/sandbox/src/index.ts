/**
 * Service Definition for the same-world process-confinement capability seam: wrap exact subprocess argv under a
 * host-path file policy. Containers, microVMs, and remote execution replace the
 * surrounding capability seam instead; this service shares the host kernel and filesystem.
 * @module @deepseek-ai/dsh-sandbox
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

export {
  ESCALATION_TARGETS,
  WIDER_MODES,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from './escalation.ts'
export type { EscalationApproval, EscalationApprover, EscalationOutcome, EscalationRequest } from './escalation.ts'
export { canonicalPath, writableRoots } from './roots.ts'

/**
 * File-effect policy for confined processes. `read-only` permits only required
 * sinks such as `/dev/null`; `workspace-write` also permits the workspace and a
 * backend-defined temp area; `danger-full-access` bypasses confinement. Network
 * and process visibility are outside this vocabulary.
 */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** A confining (non-`danger-full-access`) mode — the modes a {@link SandboxPolicy} can carry. */
export type ConfinedSandboxMode = Exclude<SandboxMode, 'danger-full-access'>

/** The first-class profile that gives a developer the host process environment. */
export const DEVELOPER_HOST_ACCESS_PROFILE = 'developer-host-access' as const

/** The developer host-access profile identifier. */
export type DeveloperHostAccessProfile = typeof DEVELOPER_HOST_ACCESS_PROFILE

/** A deployment profile: host access by default, or an explicit sandbox opt-down. */
export type ExecutionProfile = DeveloperHostAccessProfile | SandboxMode

/** The local backend that directly execs in the current OS account/container. */
export type DeveloperHostAccessBackend = 'host-process'

/** Network visibility exposed by the developer host-access profile. */
export type DeveloperHostAccessNetwork = 'host'

/** Process visibility exposed by the developer host-access profile. */
export type DeveloperHostAccessProcessVisibility = 'host'

/** Attachment handling exposed by the developer host-access profile. */
export interface DeveloperHostAccessAttachments {
  /** Attachments are never mounted into the child process. */
  readonly mounted: false
  /** Attachment bytes remain immutable to the child process. */
  readonly immutable: true
}

/**
 * Facts the selected developer host-access backend can prove for one launch.
 * Paths are canonical absolute paths; this report contains no argv, environment
 * values, credentials, or attachment bytes.
 */
export interface DeveloperHostAccessCapabilities {
  /** The selected profile. */
  readonly profile: DeveloperHostAccessProfile
  /** The backend that will launch the child. */
  readonly backend: DeveloperHostAccessBackend
  /** The child shares the host filesystem, subject to OS account/container policy. */
  readonly filesystem: 'host'
  /** Canonical roots visible to the child. */
  readonly roots: readonly string[]
  /** Canonical working directory used for the launch. */
  readonly cwd: string
  /** Network visibility is inherited from the host process. */
  readonly network: DeveloperHostAccessNetwork
  /** Process visibility is inherited from the host process. */
  readonly processVisibility: DeveloperHostAccessProcessVisibility
  /** Attachment handling is immutable and never mounted. */
  readonly attachments: DeveloperHostAccessAttachments
}

/** A launch request for the developer host-access backend. */
export interface DeveloperHostAccessRequest {
  /** Absolute or relative cwd; the provider canonicalizes it before reporting. */
  readonly cwd?: string
  /** Session identity used only for audit correlation; never passed to the child. */
  readonly sessionId?: SessionId
}

/** The resolved policy for one developer host-access launch. */
export interface DeveloperHostAccessPolicy {
  /** The selected profile. */
  readonly profile: DeveloperHostAccessProfile
  /** Canonical working directory used for the launch. */
  readonly cwd: string
  /** Canonical roots visible to the child. */
  readonly roots: readonly string[]
  /** Optional session identity for local audit correlation. */
  readonly sessionId?: SessionId
}

/** The direct child argv and truthful capability report for one host launch. */
export interface DeveloperHostAccessArgv {
  /** The original argv, unchanged and without a sandbox runner. */
  readonly argv: string[]
  /** Capabilities actually provided by the selected backend. */
  readonly capabilities: DeveloperHostAccessCapabilities
}

/** Structured audit record for a developer host-access launch. */
export interface DeveloperHostAccessAudit {
  /** The selected profile. */
  readonly profile: DeveloperHostAccessProfile
  /** The backend selected for the launch. */
  readonly backend: DeveloperHostAccessBackend
  /** Canonical cwd used for the launch. */
  readonly cwd: string
  /** Canonical roots visible to the child. */
  readonly roots: readonly string[]
  /** The inherited network visibility. */
  readonly network: DeveloperHostAccessNetwork
  /** The inherited process visibility. */
  readonly processVisibility: DeveloperHostAccessProcessVisibility
  /** Attachment handling, without attachment content or paths. */
  readonly attachments: DeveloperHostAccessAttachments
  /** Optional session identity for local audit correlation. */
  readonly sessionId?: SessionId
}

/** Error code for a selected host-access backend that cannot launch safely. */
export const DEVELOPER_HOST_ACCESS_UNAVAILABLE = 'DEVELOPER_HOST_ACCESS_UNAVAILABLE'

/** Thrown when the selected developer host-access backend is unavailable. */
export class DeveloperHostAccessUnavailableError extends HarnessError {
  /**
   * @param detail - safe operational detail; callers must not include argv or
   *   environment values.
   */
  constructor(detail?: string) {
    super(
      'developer-host-access is selected but its host-process backend is unavailable; refusing to run the command'
      + (detail === undefined ? '' : `: ${detail}`),
      DEVELOPER_HOST_ACCESS_UNAVAILABLE,
    )
    this.name = 'DeveloperHostAccessUnavailableError'
  }
}

/**
 * The complete file-effect policy for a confined execution. The root is
 * carried even under modes that do not consume it so callers can resolve
 * policy once before choosing the enforcement path.
 */
export interface SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: SandboxMode
  /** Absolute root directory `workspace-write` may write under. */
  workspaceRoot: string
  /**
   * Opaque identity of the calling session (the branded `dsh-session`
   * SessionId). Backends key per-session state off it (e.g. windows-acl gives
   * each live session/workspace pair a random private temp directory and SID,
   * while the workspace SID and standing grant remain per-workspace); absent
   * for agentless calls, which fall back to per-call backend state.
   */
  sessionId?: SessionId
}

/**
 * Enforcement completeness for this host. `partial` means an active backend or
 * older kernel ABI cannot govern every promised file effect; callers requiring
 * an absolute boundary must not treat it as `full`.
 */
export type SandboxEnforcement = 'full' | 'partial'

/**
 * What one confined execution is allowed to touch — carried PER CALL, not
 * fixed on the provider: two consumers may confine under different policies
 * at the same instant (bash under `read-only` while a confined child agent
 * needs its state directory writable), and an approved escalated retry is a
 * new call with a wider policy. Defaulting/resolution is an explicit step at
 * the consumer boundary; the provider treats the policy as fully specified.
 */
export interface SandboxPolicy extends SandboxExecutionPolicy {
  /** The file-effect mode this execution runs under. */
  mode: ConfinedSandboxMode
}

/** One resolved execution policy selected by the deployment or session profile. */
export type ExecutionPolicy = SandboxExecutionPolicy | DeveloperHostAccessPolicy

/**
 * Evidence that identifies a sandbox runner failing before it executes the
 * wrapped command. A consumer first applies {@link allowedExitCodes} when
 * present, removes {@link informationalLines} by case-insensitive exact line
 * equality, then matches {@link fatalSignatures} case-insensitively within
 * each remaining stderr line. Exit status alone never proves runner failure.
 */
export interface RunnerFailureRule {
  /** Nonzero process exit codes on which this rule may match; omitted permits any nonzero exit. */
  allowedExitCodes?: readonly number[]
  /** Non-empty substrings identifying a fatal runner diagnostic on one stderr line. */
  fatalSignatures: readonly string[]
  /** Benign stderr lines excluded by exact full-line equality before fatal matching. */
  informationalLines?: readonly string[]
}

/**
 * A {@link SandboxProvider.confine} result: the argv to spawn in place of
 * the caller's own, plus the enforcement completeness the selected backend
 * achieves for it.
 */
export interface ConfinedArgv {
  /** The wrapped argv (runner, profile, separator, then the caller's argv). */
  argv: string[]
  /** How completely the selected backend enforces the policy's file effects. */
  enforcement: SandboxEnforcement
  /**
   * The selected backend's denial DIALECT: the case-insensitive stderr
   * substrings a file effect denied by THIS backend produces (EROFS text
   * under bwrap's read-only binds, EACCES under Landlock, EPERM under
   * Seatbelt). A consumer that infers denials from a failed run's stderr
   * matches against exactly these rather than a cross-backend union — the
   * union claims denials a given backend never produces.
   */
  denialSignatures: readonly string[]
  /**
   * Structured runner-failure evidence rules. Consumers require a matching
   * fatal stderr line (after informational exclusions) and any rule-specific
   * exit-code gate before checking denial signatures: runner failure means the
   * command never ran, while denial means confinement worked and blocked it.
   */
  runnerFailureRules: readonly RunnerFailureRule[]
}

/**
 * Error code for a requested confined mode when no backend is usable. The
 * provider fails closed, and `HarnessError` carries the code through
 * `tool/result` so callers can distinguish missing confinement from command
 * failure.
 */
export const SANDBOX_UNAVAILABLE = 'SANDBOX_UNAVAILABLE'

/**
 * Thrown when {@link SandboxProvider.confine} cannot enforce the requested
 * mode. Carries {@link SANDBOX_UNAVAILABLE} through the structured error
 * channel.
 */
export class SandboxUnavailableError extends HarnessError {
  constructor(mode: ConfinedSandboxMode, detail?: string) {
    super(
      `sandbox mode "${mode}" is requested but no sandbox backend is usable on this host; `
      + 'refusing to run the command unconfined. Install bubblewrap or run a Landlock-enforcing '
      + 'kernel (Linux), ensure sandbox-exec is usable (macOS), or ensure the ACL '
      + 'restricted-token runner can start (Windows) — otherwise switch the consumer to '
      + 'danger-full-access.'
      + (detail === undefined ? '' : ` Runner failure: ${detail}`),
      SANDBOX_UNAVAILABLE,
    )
    this.name = 'SandboxUnavailableError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandbox: SandboxProvider
    developerHostAccess: DeveloperHostAccessProvider
  }

  interface Events {
    /**
     * Audit record emitted after a developer host-access launch has resolved.
     * The payload contains capability facts only; argv, environment values,
     * credentials, and attachment bytes are never emitted.
     * @param audit - non-secret capability and root facts for the launch.
     * @mode emit
     */
    'developer-host-access/audit'(audit: DeveloperHostAccessAudit): void
  }
}

/**
 * Abstract developer host-access service. It launches the exact child argv in
 * the current OS account and container without a sandbox runner, or fails
 * closed when that backend cannot be proven available.
 */
export abstract class DeveloperHostAccessProvider extends Service {
  /* v8 ignore next -- abstract service construction is covered through concrete provider packages. */
  constructor(ctx: Context) {
    super(ctx, 'developerHostAccess')
  }

  /**
   * Report the actual host capabilities for a requested working directory.
   * @param request - optional cwd and audit session identity.
   * @returns canonical capability facts without secrets.
   */
  abstract capabilities(request?: DeveloperHostAccessRequest): DeveloperHostAccessCapabilities

  /**
   * Return the exact child argv for direct host execution.
   * @param argv - the exact child argv, never a shell string.
   * @param policy - the resolved developer host-access policy.
   * @returns unchanged argv and the capabilities applied to that launch.
   */
  abstract launch(argv: readonly string[], policy: DeveloperHostAccessPolicy): DeveloperHostAccessArgv
}

/**
 * Abstract process-sandbox service. {@link confine} must return enforcing argv
 * or fail closed at wrap or runner-execution time; silent unconfined passthrough
 * is forbidden. Functional probes arbitrate multi-runner chains and may be
 * skipped for a sole candidate, whose own refusal remains the fail-closed end.
 */
export abstract class SandboxProvider extends Service {
  /* v8 ignore next -- abstract service construction is covered through concrete provider packages. */
  constructor(ctx: Context) {
    super(ctx, 'sandbox')
  }

  /**
   * Wrap `argv` so it executes confined under `policy` on this host; the
   * caller spawns the returned argv in place of its own.
   * @param argv - the exact argv the caller is about to spawn (program plus
   *   arguments), NOT a shell string — a shell-shaped consumer passes
   *   `['bash', '-c', command]`.
   * @param policy - the file-effect policy this execution runs under,
   *   carried per call (see {@link SandboxPolicy}).
   * @returns the argv to spawn instead, plus the enforcement completeness
   *   the selected backend achieves for it.
   */
  abstract confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv
}

export default SandboxProvider
