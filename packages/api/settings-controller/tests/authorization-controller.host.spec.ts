import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import AuthorizationService, {
  type AuthorizationFlow,
  type AuthorizationSession,
} from '@deepseek-ai/dsh-authorization'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationFrame } from '../src/types.ts'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'

const KEY = credentialKey('llm-pi-ai', 'openai-codex')
const KEY_STRING = 'llm-pi-ai/openai-codex'

async function boot(): Promise<{ ctx: Context; controller: AuthorizationController }> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(AuthorizationController)
  return { ctx, controller: ctx.authorizationController }
}

/** A device-code flow: notice with url+code, one secret prompt, then grant. */
function deviceFlow(ctx: Context): AuthorizationFlow {
  return {
    key: KEY,
    label: 'ChatGPT (Codex)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    async run(session: AuthorizationSession) {
      session.notify({
        message: 'Enter this code on the verification page to finish signing in.',
        url: 'https://auth.openai.com/codex/device',
        code: 'ABCD-EFGH',
      })
      await session.prompt({ kind: 'secret', message: 'Paste the confirmation code.' })
      await ctx.credentials.modifyRecord(KEY, () =>
        Promise.resolve({ kind: 'grant', payload: { token: 'granted' } }))
    },
  }
}

/** Collect every frame of one attempt, answering prompts through `respond`. */
async function collect(
  controller: AuthorizationController,
  request: { key: string; method?: string },
  respond: (frame: AuthorizationFrame) => Promise<void> = () => Promise.resolve(),
): Promise<AuthorizationFrame[]> {
  const frames: AuthorizationFrame[] = []
  for await (const frame of controller.run(request, new AbortController().signal)) {
    frames.push(frame)
    await respond(frame)
  }
  return frames
}

describe('the authorization Remote namespace a configuration surface calls', () => {
  it('publishes the authorization namespace from its own service key', async () => {
    const { controller } = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('authorizationController')
    expect(binding.namespace).toBe('authorization')
    expect(remoteMethods(controller).map(marker => marker.method).sort()).toEqual([
      'answer',
      'cancel',
      'list',
      'run',
    ])
  })

  it('reports the actionable configuration error while no authorization service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationController)
    const signal = new AbortController().signal
    for (const call of [
      () => ctx.authorizationController.list(),
      () => collect(ctx.authorizationController, { key: KEY_STRING }),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({
        code: 'gateway/internal',
        message: 'authorization service is absent: this deployment does not mount @deepseek-ai/dsh-authorization in its composition',
      })
    }
    // Prompt answers and cancellations validate against the attempt table
    // before touching the seam, so unknown ids fail the same way with or
    // without a mounted service.
    for (const call of [
      () => ctx.authorizationController.answer({ attemptId: 'nope', promptId: 'nope', value: 'x' }),
      () => ctx.authorizationController.cancel({ attemptId: 'nope' }),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
    expect(signal.aborted).toBe(false)
  })

  it('lists flows with their configured and in-flight state, values excluded', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(deviceFlow(ctx))
    expect(await controller.list()).toEqual([{
      key: KEY_STRING,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      configured: false,
      inFlight: false,
    }])
    expect(JSON.stringify(await controller.list())).not.toContain('granted')
  })

  it('runs a device-code conversation to an authorized settlement', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(deviceFlow(ctx))
    const frames = await collect(controller, { key: KEY_STRING }, (() => {
      let attemptId = ''
      return async (frame: AuthorizationFrame) => {
        if (frame.type === 'started') attemptId = frame.attemptId
        if (frame.type === 'prompt') {
          await controller.answer({ attemptId, promptId: frame.promptId, value: 'confirmed' })
        }
      }
    })())
    expect(frames[0]).toMatchObject({ type: 'started', key: KEY_STRING })
    const attemptId = frames[0]?.type === 'started' ? frames[0].attemptId : ''
    expect(attemptId.length).toBeGreaterThan(0)
    expect(frames).toContainEqual({
      type: 'notice',
      notice: {
        message: 'Enter this code on the verification page to finish signing in.',
        url: 'https://auth.openai.com/codex/device',
        code: 'ABCD-EFGH',
      },
    })
    const prompt = frames.find(frame => frame.type === 'prompt')
    expect(prompt).toMatchObject({
      type: 'prompt',
      prompt: { kind: 'secret', message: 'Paste the confirmation code.' },
    })
    expect(frames.at(-1)).toEqual({ type: 'settled', status: 'authorized' })
    expect(await controller.list()).toMatchObject([{ key: KEY_STRING, configured: true, inFlight: false }])
  })

  it('reports a failing flow as a failed frame carrying its message', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: () => Promise.reject(new Error('provider exploded')),
    })
    const frames = await collect(controller, { key: KEY_STRING })
    expect(frames[0]?.type).toBe('started')
    expect(frames.at(-1)).toMatchObject({ type: 'failed', message: 'provider exploded' })
  })

  it('reports an unknown method as a failed frame', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow(deviceFlow(ctx))
    const frames = await collect(controller, { key: KEY_STRING, method: 'api-key' })
    expect(frames.at(-1)).toMatchObject({ type: 'failed' })
  })

  it('rejects unparsable keys and unknown attempts without starting anything', async () => {
    const { controller } = await boot()
    for (const call of [
      () => collect(controller, { key: 'not a key' }),
      () => controller.answer({ attemptId: 'nope', promptId: 'nope', value: 'x' }),
      () => controller.cancel({ attemptId: 'nope' }),
    ]) {
      const failure = await call().catch((error: unknown) => error)
      expect(remoteErrorOf(failure)).toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('withdraws a running attempt as cancelled', async () => {
    const { ctx, controller } = await boot()
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'ChatGPT (Codex)',
      methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
      run: session => session.prompt({ kind: 'text', message: 'Waiting.' }).then(() => {}),
    })
    const frames: AuthorizationFrame[] = []
    const pump = (async () => {
      for await (const frame of controller.run({ key: KEY_STRING }, new AbortController().signal)) {
        frames.push(frame)
      }
    })()
    while (!frames.some(frame => frame.type === 'prompt')) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const attemptId = frames[0]?.type === 'started' ? frames[0].attemptId : ''
    expect((await controller.list())[0]).toMatchObject({ inFlight: true })
    await expect(controller.cancel({ attemptId })).resolves.toEqual({ cancelled: true })
    await pump
    expect(frames.at(-1)).toEqual({ type: 'settled', status: 'cancelled' })
    expect((await controller.list())[0]).toMatchObject({ inFlight: false })
  })
})
