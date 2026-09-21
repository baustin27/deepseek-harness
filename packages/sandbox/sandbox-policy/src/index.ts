/**
 * The sandbox POLICY home (`ctx.sandboxPolicy`): the single owner of the
 * deployment's sandbox fallbacks plus per-session resolution: the file-effect
 * {@link SandboxMode}, the `workspace-write` root, and the override kit (the
 * `sandbox/mode` event, its fold, and its write path; the fold is the
 * `sandboxMode` session-projection unit registered here, while the event and
 * write path come from `./session-mode.ts`).
 * Before each agent request, the owner also contributes the resolved policy to
 * the cache-safe runtime-context snapshot. The agent loop logs that snapshot as
 * model history, so replay reconstructs the same mode and root the enforcing
 * consumers resolve without rewriting the stable system prompt.
 *
 * Enforcing filesystem, one-shot bash, and terminal backends read the SAME
 * resolved policy here. The context describes that policy without inventorying
 * capabilities, while each backend retains its own enforcement dialect and each
 * tool owns its operation-specific denial and escalation guidance. The service
 * reads session state once at each operation boundary; executors and providers
 * remain session-free.
 *
 * @module @deepseek-ai/dsh-sandbox-policy
 */

import { parse, resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import {
  DEVELOPER_HOST_ACCESS_PROFILE,
  type DeveloperHostAccessPolicy,
  type ExecutionPolicy,
  type ExecutionProfile,
  canonicalPath,
  type SandboxExecutionPolicy,
  type SandboxMode,
} from '@deepseek-ai/dsh-sandbox'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'

export {
  EXECUTION_PROFILES,
  SANDBOX_MODES,
  setExecutionProfile,
  setSandboxMode,
} from './session-mode.ts'

/** Resolve filesystem identity before lexical normalization can erase symlink-sensitive components. */
function resolveWorkspaceRoot(path: string): string {
  return resolvePath(canonicalPath(path))
}

/** Resolve the complete host filesystem root for a canonical cwd. */
function resolveHostRoot(cwd: string): string {
  const root = parse(cwd).root
  return canonicalPath(root.length === 0 ? cwd : root)
}

/** Resolve host access policy facts without mounting attachments or changing roots. */
function hostPolicy(cwd: string, sessionId?: SessionId): DeveloperHostAccessPolicy {
  const resolvedCwd = resolveWorkspaceRoot(cwd)
  return {
    profile: DEVELOPER_HOST_ACCESS_PROFILE,
    cwd: resolvedCwd,
    roots: [resolveHostRoot(resolvedCwd)],
    ...sessionId === undefined ? {} : { sessionId },
  }
}

/** Render the policy without claiming which capabilities are mounted. */
function renderPolicyContext(policy: ExecutionPolicy): string {
  if ('profile' in policy) {
    return `Current DSH execution profile: developer-host-access. Child processes run directly in the current OS account and container with host filesystem root ${JSON.stringify(policy.roots[0])}; network and process visibility are inherited from the host. Attachments remain immutable and are not mounted.`
  }
  const sandboxPolicy: SandboxExecutionPolicy = policy
  switch (sandboxPolicy.mode) {
    case 'read-only':
      return 'Current DSH file policy: read-only. Any available operation enforced by the DSH file sandbox cannot modify files in the standing mode. Do not refuse a required modification from this policy alone: try an available tool normally and follow any denial and escalation guidance it returns.'
    case 'workspace-write':
      return `Current DSH file policy: workspace-write. Any available operation enforced by the DSH file sandbox may modify files under the session workspace: ${JSON.stringify(sandboxPolicy.workspaceRoot)}. Some platform temporary areas may also be writable.`
    case 'danger-full-access':
      return 'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.'
    /* v8 ignore next 4 -- SandboxMode is a typed same-process closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const mode: never = sandboxPolicy.mode
      throw new Error(`unreachable sandbox mode: ${String(mode)}`)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sandboxPolicy: SandboxPolicyService
  }
}

/**
 * Plugin config: the deployment's sandbox default. All optional — `Config`
 * supplies the defaults (`mode: 'read-only'` is the fail-safe default; a
 * deployment that wants a workspace-writable agent opts in explicitly). The
 * runner choice is NOT here (it is the `ctx.sandbox` provider's config), nor
 * is any per-family knob: this is the one shared policy home.
 */
export interface Config {
  /** Default execution profile; host access is used when omitted. */
  executionProfile?: ExecutionProfile
  /** Legacy explicit sandbox opt-down; equivalent to `executionProfile` when set. */
  mode?: SandboxMode
  /**
   * Fallback root for agentless calls and sessions without a cwd (default:
   * `process.cwd()`). Normal agent calls use their session cwd instead.
   */
  workspaceRoot?: string
}

/** Inputs that select the execution policy for one capability call. */
export interface SandboxPolicyRequest {
  /** Calling session; its immutable cwd becomes the execution root. */
  session?: Session
  /** Explicit approved sandbox mode override, which outranks profile state. */
  mode?: SandboxMode
  /** Explicit profile override, which outranks the session profile state. */
  profile?: ExecutionProfile
}

/** The sandbox-mode projection's state schema (state equals the public shape). */
const sandboxModeStateSchema = zod.union([
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

type SandboxModeState = zod.infer<typeof sandboxModeStateSchema>
const executionProfileStateSchema = zod.union([
  zod.literal(DEVELOPER_HOST_ACCESS_PROFILE),
  zod.literal('read-only'),
  zod.literal('workspace-write'),
  zod.literal('danger-full-access'),
]).nullable()

/** Session profile state before the deployment default is applied. */
export type ExecutionProfileState = zod.infer<typeof executionProfileStateSchema>

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Last logged sandbox-mode override, or null before one (deployment default applies at resolve time). */
    sandboxMode: SandboxModeState
    /** Last logged execution-profile override, or null before one (deployment default applies at resolve time). */
    executionProfile: ExecutionProfileState
  }
}

/**
 * The sandbox-policy service (`ctx.sandboxPolicy`). Owns the deployment
 * default mode, fallback workspace root, and current request-time policy
 * section. Tool layers call {@link resolve} for each execution so a session's
 * mode log and immutable cwd travel together to every enforcing capability.
 */
/** Default profile for every new session and deployment. */
export const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = DEVELOPER_HOST_ACCESS_PROFILE

export class SandboxPolicyService extends Service {
  // Inline schema call: the config catalog walks `static Config` statically.
  static Config: z<Config> = z.object({
    executionProfile: z.union(['developer-host-access', 'read-only', 'workspace-write', 'danger-full-access'] as const).default('developer-host-access'),
    mode: z.union(['read-only', 'workspace-write', 'danger-full-access'] as const),
    // No schema default: process.cwd() is resolved in the constructor so the
    // stored root is always absolute regardless of how it was supplied.
    workspaceRoot: z.string(),
  })

  static inject = ['sessionProjections']

  /** The deployment default profile — host access unless explicitly opted down. */
  readonly defaultProfile: ExecutionProfile
  /** The deployment default sandbox mode, when the profile is a sandbox opt-down. */
  readonly defaultMode: SandboxMode | undefined
  /** The absolute `workspace-write` fallback root for calls without a session cwd. */
  readonly workspaceRoot: string
  constructor(ctx: Context, config: Config) {
    super(ctx, 'sandboxPolicy')
    // An explicit legacy mode remains an opt-down. Otherwise host access is
    // the default for new sessions and deployments.
    this.defaultProfile = config.mode ?? config.executionProfile ?? DEFAULT_EXECUTION_PROFILE
    this.defaultMode = this.defaultProfile === DEVELOPER_HOST_ACCESS_PROFILE ? undefined : this.defaultProfile
    this.workspaceRoot = resolveWorkspaceRoot(config.workspaceRoot ?? process.cwd())

    ctx.sessionProjections.register({
      key: 'sandboxMode',
      stateVersion: 1,
      stateSchema: sandboxModeStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'sandbox/mode' ? event.data.mode : state),
    })
    ctx.sessionProjections.register({
      key: 'executionProfile',
      stateVersion: 1,
      stateSchema: executionProfileStateSchema,
      init: () => null,
      apply: (state, event) => (event.type === 'execution/profile' ? event.data.profile : state),
    })

    ctx.inject(['systemPrompt'], (scope: Context) => {
      scope.systemPrompt.context({
        name: 'sandbox:policy',
        order: scope.systemPrompt.getContextOrder('SANDBOX_POLICY'),
        text: (context) => {
          const session = context.agent?.session
          return session === undefined
            ? ''
            : renderPolicyContext(this.resolve({ session }))
        },
      })
    })
  }

  /**
   * Resolve the complete policy for one capability call. An explicit mode or
   * profile outranks the session profile event, which outranks the deployment
   * default. A session cwd is the policy cwd; the configured root is the
   * fallback for agentless calls and sessions without a cwd.
   * @param request - optional session and approved profile override.
   * @returns a host-access policy or a sandbox file-effect policy.
   */
  resolve(request: SandboxPolicyRequest = {}): ExecutionPolicy {
    const { session } = request
    const profile = request.mode
      ?? request.profile
      ?? (session === undefined ? undefined : this.profileOf(session))
      ?? (session === undefined ? undefined : this.overrideOf(session))
      ?? this.defaultProfile
    const cwd = resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
    if (profile === DEVELOPER_HOST_ACCESS_PROFILE) return hostPolicy(cwd, session?.id)
    return {
      mode: profile,
      workspaceRoot: cwd,
      ...session === undefined ? {} : { sessionId: session.id },
    }
  }

  /**
   * Read the session sandbox-mode override without applying a default.
   * @param session - session whose log supplies the override.
   * @returns the last logged mode, or `undefined` without one.
   */
  overrideOf(session: Session): SandboxMode | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'sandboxMode') ?? undefined
  }

  /**
   * Read the session execution-profile override without applying a default.
   * @param session - session whose log supplies the override.
   * @returns the last logged profile, or `undefined` without one.
   */
  profileOf(session: Session): ExecutionProfile | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'executionProfile') ?? undefined
  }
}

export default SandboxPolicyService
