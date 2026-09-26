/**
 * Host owner of the `authorization` Remote namespace: browser-safe views over
 * the registered `ctx.authorization` flows plus one streamed conversation per
 * attempt. Frames carry notices and prompts to the page that started the
 * attempt; answers and cancellation travel back as separate calls. Secrets
 * never cross in either direction — prompts carry questions, answers carry
 * the human's reply to the flow, and the grant itself stays in the host
 * credential store the flow writes.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/authorization.ts
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationNotice,
  AuthorizationPrompt,
  AuthorizationService,
} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-authorization'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type {
  AuthorizationAnswerRequest,
  AuthorizationAnswerValue,
  AuthorizationCancelRequest,
  AuthorizationCancelValue,
  AuthorizationFlowView,
  AuthorizationFrame,
  AuthorizationPromptView,
  AuthorizationRunRequest,
} from './types.ts'

const keySchema = z.string().min(1).max(256)
const runRequestSchema = z.object({ key: keySchema, method: z.string().min(1).max(128).optional() })
const answerRequestSchema = z.object({
  attemptId: z.string().min(1).max(128),
  promptId: z.string().min(1).max(128),
  value: z.string().max(65536),
})
const cancelRequestSchema = z.object({ attemptId: z.string().min(1).max(128) })

/** Parse the domain constraints that are more specific than generated TypeScript codecs. */
function parseRequest<T>(method: string, schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new RemoteError('gateway/bad-request', `invalid payload for ${method}`, { issues: parsed.error.issues })
  }
  return parsed.data
}

/** One prompt awaiting the page's answer. */
interface PendingPrompt {
  readonly resolve: (value: string) => void
  readonly reject: (error: unknown) => void
}

/** One browser authorization conversation in flight. */
interface Attempt {
  readonly key: string
  readonly controller: AbortController
  readonly pending: Map<string, PendingPrompt>
}

/**
 * Project one seam prompt onto its wire view, dropping the host-only
 * cancellation signal: prompt lifetime is owned by the attempt, answered or
 * withdrawn through `answer`/`cancel` calls naming its id.
 */
function projectPrompt(prompt: AuthorizationPrompt): AuthorizationPromptView {
  if (prompt.kind === 'select') {
    return {
      message: prompt.message,
      kind: 'select',
      options: prompt.options.map(option => ({
        id: option.id,
        label: option.label,
        ...option.description === undefined ? {} : { description: option.description },
      })),
    }
  }
  return {
    message: prompt.message,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
    kind: prompt.kind,
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace. It
 * carries every wire obligation the authorization seam itself does not: key
 * grammar, per-attempt prompt plumbing, frame projection, and the refusal
 * mapping. The seam keeps owning flow registry, attempt mutual exclusion, and
 * commit confirmation.
 */
export class AuthorizationController extends TypertRemoteService {
  private readonly attempts = new Map<string, Attempt>()

  /** @param ctx - Host context where the authorization service may be mounted. */
  constructor(ctx: Context) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
  }

  /**
   * List every registered authorization flow with its configured state.
   * @returns one browser-safe view per flow, in registration order.
   * @throws RemoteError when no authorization service is mounted.
   */
  @Remote
  async list(): Promise<AuthorizationFlowView[]> {
    const authorization = this.authorization()
    const credentials = this.ctx.get('credentials')
    return Promise.all(authorization.list().map(async entry => ({
      key: entry.key,
      label: entry.label,
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      configured: credentials === undefined
        ? false
        : (await credentials.describeRecord(entry.key)).configured,
      inFlight: entry.inFlight,
    })))
  }

  /**
   * Run one authorization attempt as a streamed frame conversation.
   * @param request - the credential record key plus the optional method id.
   * @param signal - Remote stream cancellation; withdrawing it aborts the attempt.
   * @returns started/notice/prompt frames, then exactly one terminal frame.
   * @throws RemoteError when the request is invalid or no authorization service is mounted.
   */
  @Remote({ mode: 'stream' })
  async *run(request: AuthorizationRunRequest, signal: AbortSignal): AsyncIterable<AuthorizationFrame> {
    const parsed = parseRequest('authorization.run', runRequestSchema, request)
    let key: ReturnType<typeof parseCredentialKey>
    try {
      key = parseCredentialKey(parsed.key)
    } catch {
      throw new RemoteError('gateway/bad-request', `authorization key "${parsed.key}" must be "<scope>/<id>"`, {})
    }
    const authorization = this.authorization()
    const attemptId = randomUUID()
    const controller = new AbortController()
    const attempt: Attempt = { key: parsed.key, controller, pending: new Map() }
    this.attempts.set(attemptId, attempt)
    // The carrier withdrawing the stream aborts the attempt like an explicit
    // cancel: without this a disconnected page would leak its attempt entry.
    const onCarrierAbort = (): void => { controller.abort(signal.reason) }
    signal.addEventListener('abort', onCarrierAbort, { once: true })
    // Frames queue: the generator drains in order while the flow produces.
    const frames: AuthorizationFrame[] = [{ type: 'started', attemptId, key: parsed.key }]
    let waiting: (() => void) | undefined
    const push = (frame: AuthorizationFrame): void => {
      frames.push(frame)
      waiting?.()
      waiting = undefined
    }
    const next = (): Promise<AuthorizationFrame | undefined> => {
      const frame = frames.shift()
      if (frame !== undefined) return Promise.resolve(frame)
      return new Promise<AuthorizationFrame | undefined>((resolve) => { waiting = () => { resolve(frames.shift()) } })
    }
    const prompt = (question: AuthorizationPrompt): Promise<string> => new Promise<string>((resolve, reject) => {
      const promptId = randomUUID()
      attempt.pending.set(promptId, { resolve, reject })
      push({ type: 'prompt', promptId, prompt: projectPrompt(question) })
    })
    // The attempt runs beside the frame drain below, not before it: prompts
    // are answered from frames this generator yields, so awaiting the attempt
    // first would deadlock every conversation that asks anything.
    void authorization.begin({
      key,
      ...parsed.method === undefined ? {} : { method: parsed.method },
      interaction: {
        notify: (notice: AuthorizationNotice) => {
          push({
            type: 'notice',
            notice: {
              message: notice.message,
              ...notice.url === undefined ? {} : { url: notice.url },
              ...notice.code === undefined ? {} : { code: notice.code },
            },
          })
        },
        prompt,
      },
      signal: controller.signal,
    }).then(
      (outcome) => { push({ type: 'settled', status: outcome.status }) },
      (error: unknown) => {
        if (error instanceof AuthorizationDeclinedError || controller.signal.aborted) {
          push({ type: 'settled', status: 'cancelled' })
        } else {
          push({
            type: 'failed',
            ...error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
              ? { code: (error as { code: string }).code }
              : {},
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    ).finally(() => {
      signal.removeEventListener('abort', onCarrierAbort)
      for (const [, pending] of attempt.pending) pending.reject(new Error('authorization attempt finished'))
      attempt.pending.clear()
      this.attempts.delete(attemptId)
    })
    let frame = await next()
    // Frames arrive in push order with exactly one terminal frame last:
    // notices precede it, prompts are answered or rejected above, and nothing
    // is pushed after the terminal frame.
    while (frame !== undefined) {
      yield frame
      if (frame.type === 'settled' || frame.type === 'failed') break
      frame = await next()
    }
  }

  /**
   * Answer one prompt previously emitted by an authorization attempt.
   * @param request - the attempt, the prompt, and the human's reply.
   * @throws RemoteError when the request is invalid or names nothing pending.
   */
  @Remote
  async answer(request: AuthorizationAnswerRequest): Promise<AuthorizationAnswerValue> {
    const parsed = parseRequest('authorization.answer', answerRequestSchema, request)
    const attempt = this.attempts.get(parsed.attemptId)
    const pending = attempt?.pending.get(parsed.promptId)
    if (pending === undefined) {
      throw new RemoteError(
        'gateway/bad-request',
        `no pending prompt "${parsed.promptId}" for attempt "${parsed.attemptId}"`,
        {},
      )
    }
    attempt?.pending.delete(parsed.promptId)
    pending.resolve(parsed.value)
    return { accepted: true }
  }

  /**
   * Withdraw one authorization attempt.
   * @param request - the attempt to stop.
   * @throws RemoteError when the request is invalid or names nothing running.
   */
  @Remote
  async cancel(request: AuthorizationCancelRequest): Promise<AuthorizationCancelValue> {
    const parsed = parseRequest('authorization.cancel', cancelRequestSchema, request)
    const attempt = this.attempts.get(parsed.attemptId)
    if (attempt === undefined) {
      throw new RemoteError(
        'gateway/bad-request',
        `no running authorization attempt "${parsed.attemptId}"`,
        {},
      )
    }
    attempt.controller.abort()
    return { cancelled: true }
  }

  /** Resolve the authorization service or report how to supply it. */
  private authorization(): AuthorizationService {
    const authorization = this.ctx.get('authorization')
    if (authorization === undefined) {
      throw new RemoteError(
        'gateway/internal',
        'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
        {},
      )
    }
    return authorization
  }
}

export default AuthorizationController
