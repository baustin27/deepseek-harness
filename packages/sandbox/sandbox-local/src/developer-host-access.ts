/**
 * Direct host-process backend for the developer-host-access profile.
 *
 * This backend deliberately does not invoke bwrap, Landlock, Seatbelt, an ACL
 * runner, or any other confinement helper. The child stays inside the launching
 * process's OS account and container. Availability is checked before every
 * launch; a failed check never returns a passthrough argv.
 *
 * @module @deepseek-ai/dsh-sandbox-local/developer-host-access
 */

import { isAbsolute, parse, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  DEVELOPER_HOST_ACCESS_PROFILE,
  DeveloperHostAccessProvider,
  DeveloperHostAccessUnavailableError,
  canonicalPath,
} from '@deepseek-ai/dsh-sandbox'
import type {
  DeveloperHostAccessArgv,
  DeveloperHostAccessAudit,
  DeveloperHostAccessCapabilities,
  DeveloperHostAccessPolicy,
  DeveloperHostAccessRequest,
} from '@deepseek-ai/dsh-sandbox'

/** Config for the direct host-process backend. */
export interface DeveloperHostAccessConfig {
  /** Disable the backend and fail closed when the host profile is selected. */
  enabled?: boolean
}

/** Injectable host checks for deterministic backend and path tests. */
export interface DeveloperHostAccessInternals {
  /** Replaces the backend-availability probe. */
  probe?: () => boolean
  /** Replaces the process platform used to derive the host filesystem root. */
  platform?: string
}

/** The direct host-process backend's static capabilities. */
export const DEVELOPER_HOST_ACCESS_CAPABILITIES = {
  profile: DEVELOPER_HOST_ACCESS_PROFILE,
  backend: 'host-process',
  filesystem: 'host',
  network: 'host',
  processVisibility: 'host',
  attachments: { mounted: false, immutable: true },
} as const

/**
 * Resolve the canonical cwd used by the host backend. The path is made
 * absolute before realpath resolution so a relative caller cwd cannot leak a
 * different interpretation into the capability report.
 * @param cwd - caller-provided cwd or the launching process cwd.
 * @returns canonical absolute cwd.
 */
export function resolveHostAccessCwd(cwd = process.cwd()): string {
  const absolute = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
  return canonicalPath(absolute)
}

/**
 * Resolve the canonical filesystem root containing a cwd. A host profile has
 * no workspace allow-list, so this root describes the complete host filesystem
 * visible inside the current OS account/container.
 * @param cwd - canonical absolute cwd.
 * @returns canonical host filesystem root.
 */
export function resolveHostAccessRoot(cwd: string): string {
  const root = parse(cwd).root
  return canonicalPath(root.length === 0 ? cwd : root)
}

/**
 * Build truthful host-access capabilities for one request. This pure helper is
 * exported so API and tests can render the same report as the provider.
 * @param request - optional cwd and audit identity.
 * @returns capability facts without argv, environment values, or attachment bytes.
 */
export function hostAccessCapabilities(request: DeveloperHostAccessRequest = {}): DeveloperHostAccessCapabilities {
  const cwd = resolveHostAccessCwd(request.cwd)
  return {
    ...DEVELOPER_HOST_ACCESS_CAPABILITIES,
    roots: [resolveHostAccessRoot(cwd)],
    cwd,
  }
}

/** Probe whether Node can launch a child in the current host process world. */
function defaultProbe(): boolean {
  return process.pid > 0 && process.platform.length > 0 && process.execPath.length > 0
}

/**
 * Local direct host-process provider. `launch` returns the caller argv
 * unchanged; consumers pass that argv to their normal subprocess service.
 */
export class LocalDeveloperHostAccessProvider extends DeveloperHostAccessProvider {
  static Config: z<DeveloperHostAccessConfig> = z.object({
    enabled: z.boolean().default(true),
  })

  /** Test hook for availability and platform checks. */
  internals: DeveloperHostAccessInternals = {}

  private readonly enabled: boolean

  constructor(ctx: Context, config: DeveloperHostAccessConfig) {
    super(ctx)
    this.enabled = config.enabled as boolean
  }

  /**
   * Report host capabilities for a cwd after verifying the direct backend.
   * @param request - optional cwd and audit identity.
   * @returns truthful host capability facts.
   */
  override capabilities(request: DeveloperHostAccessRequest = {}): DeveloperHostAccessCapabilities {
    this.assertAvailable()
    return hostAccessCapabilities(request)
  }

  /**
   * Launch exact argv in the current OS account and container.
   * @param argv - exact child argv, never a shell string.
   * @param policy - resolved host-access policy.
   * @returns unchanged argv and the actual capability report.
   */
  override launch(argv: readonly string[], policy: DeveloperHostAccessPolicy): DeveloperHostAccessArgv {
    if (policy.profile !== DEVELOPER_HOST_ACCESS_PROFILE) {
      throw new DeveloperHostAccessUnavailableError(`unsupported profile "${policy.profile}"`)
    }
    const capabilities = this.capabilities(
      policy.sessionId === undefined
        ? { cwd: policy.cwd }
        : { cwd: policy.cwd, sessionId: policy.sessionId },
    )
    if (!sameRoots(capabilities.roots, policy.roots)) {
      throw new DeveloperHostAccessUnavailableError('the host-access roots do not match the canonical cwd')
    }
    const audit: DeveloperHostAccessAudit = {
      profile: capabilities.profile,
      backend: capabilities.backend,
      cwd: capabilities.cwd,
      roots: capabilities.roots,
      network: capabilities.network,
      processVisibility: capabilities.processVisibility,
      attachments: capabilities.attachments,
      ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
    }
    this.ctx.emit('developer-host-access/audit', audit)
    return { argv: [...argv], capabilities }
  }

  /** Fail closed before returning any child argv. */
  private assertAvailable(): void {
    const probe = this.internals.probe ?? defaultProbe
    if (!this.enabled || !probe()) throw new DeveloperHostAccessUnavailableError()
  }
}

function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((root, index) => root === right[index])
}

export default LocalDeveloperHostAccessProvider
