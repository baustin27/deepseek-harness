// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthorizationSection } from '../src/client/AuthorizationSection.tsx'
import type {
  AuthorizationFlowView,
  AuthorizationFrame,
  AuthorizationRemote,
} from '../src/client/AuthorizationSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  document.getElementById('root')?.remove()
})

function mount(remote: AuthorizationRemote) {
  const appRoot = document.createElement('div')
  appRoot.id = 'root'
  document.body.append(appRoot)
  render(<AuthorizationSection remote={remote} t={key => en[key]} />, { container: appRoot })
}

function flowsResponse(flows: readonly AuthorizationFlowView[]) {
  return { ok: true as const, value: flows }
}

function codexFlow(overrides: Partial<AuthorizationFlowView> = {}): AuthorizationFlowView {
  return {
    key: 'llm-pi-ai/openai-codex',
    label: 'Codex',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    configured: false,
    inFlight: false,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((inner) => { resolve = inner })
  return { promise, resolve }
}

describe('AuthorizationSection', () => {
  it('lists flows with their configured state', async () => {
    const remote: AuthorizationRemote = {
      list: () => Promise.resolve(flowsResponse([codexFlow(), codexFlow({
        key: 'other',
        label: 'Other',
        configured: true,
      })])),
      run: () => (async function *() {})(),
      answer: () => Promise.resolve({ ok: true, value: { accepted: true } }),
      cancel: () => Promise.resolve({ ok: true, value: { cancelled: true } }),
    }
    mount(remote)
    await waitFor(() => { expect(screen.getByText('Codex')).toBeTruthy() })
    expect(screen.getByText('Other')).toBeTruthy()
    expect(screen.getAllByText(en.authMissing)).toHaveLength(1)
    expect(screen.getByText(en.authConnected)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: en.authSignIn })).toHaveLength(2)
  })

  it('renders nothing when no flow is registered', async () => {
    const remote: AuthorizationRemote = {
      list: () => Promise.resolve(flowsResponse([])),
      run: () => (async function *() {})(),
      answer: () => Promise.resolve({ ok: true, value: { accepted: true } }),
      cancel: () => Promise.resolve({ ok: true, value: { cancelled: true } }),
    }
    mount(remote)
    await waitFor(() => { expect(screen.queryByText(en.authLoading)).toBeNull() })
    expect(document.getElementById('root')?.textContent).toBe('')
  })

  it('runs a device-code conversation to an authorized settlement', async () => {
    const gate = deferred<string>()
    const answers: string[] = []
    const frames: AuthorizationFrame[] = [
      { type: 'started', attemptId: 'attempt-1', key: 'llm-pi-ai/openai-codex' },
      {
        type: 'notice',
        notice: {
          message: 'Open the browser to continue.',
          url: 'https://auth.openai.com/codex/device',
          code: 'ABCD-EFGH',
        },
      },
      { type: 'prompt', promptId: 'prompt-1', prompt: { kind: 'secret', message: 'Paste the code.' } },
    ]
    const remote: AuthorizationRemote = {
      list: vi.fn()
        .mockResolvedValueOnce(flowsResponse([codexFlow()]))
        .mockResolvedValue(flowsResponse([codexFlow({ configured: true })])),
      run: () => (async function *() {
        yield* frames
        await gate.promise
        yield { type: 'settled', status: 'authorized' }
      })(),
      answer: (request) => {
        answers.push(request.value)
        gate.resolve(request.value)
        return Promise.resolve({ ok: true, value: { accepted: true } })
      },
      cancel: () => Promise.resolve({ ok: true, value: { cancelled: true } }),
    }
    mount(remote)
    await waitFor(() => { expect(screen.getByText('Codex')).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authSignIn }))
    })
    await waitFor(() => { expect(screen.getByText('Open the browser to continue.')).toBeTruthy() })
    expect(screen.getByRole('link', { name: en.authOpenLink }).getAttribute('href'))
      .toBe('https://auth.openai.com/codex/device')
    expect(screen.getByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText('Paste the code.')).toBeTruthy()
    const input = document.querySelector('label input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    await act(async () => {
      fireEvent.change(input!, { target: { value: 'confirmed' } })
      fireEvent.click(screen.getByRole('button', { name: en.authContinue }))
    })
    await waitFor(() => { expect(screen.getByText(en.authAuthorized)).toBeTruthy() })
    expect(answers).toEqual(['confirmed'])
    // Settling refreshes the list, flipping the row to connected.
    await waitFor(() => { expect(screen.getByText(en.authConnected)).toBeTruthy() })
  })

  it('withdraws the attempt when the human cancels', async () => {    const gate = deferred<string>()
    const remote: AuthorizationRemote = {
      list: () => Promise.resolve(flowsResponse([codexFlow()])),
      run: () => (async function *(): AsyncGenerator<AuthorizationFrame> {
        yield { type: 'started', attemptId: 'attempt-9', key: 'llm-pi-ai/openai-codex' }
        await gate.promise
        yield { type: 'settled', status: 'cancelled' }
      })(),
      answer: () => Promise.resolve({ ok: true, value: { accepted: true } }),
      cancel: (request) => {
        expect(request.attemptId).toBe('attempt-9')
        gate.resolve('')
        return Promise.resolve({ ok: true, value: { cancelled: true } })
      },
    }
    mount(remote)
    await waitFor(() => { expect(screen.getByText('Codex')).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authSignIn }))
    })
    await waitFor(() => { expect(screen.getByRole('button', { name: en.authCancel })).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authCancel }))
    })
    await waitFor(() => { expect(screen.getByText(en.authCancelled)).toBeTruthy() })
  })

  it('reports a failed attempt without losing the row', async () => {
    const remote: AuthorizationRemote = {
      list: () => Promise.resolve(flowsResponse([codexFlow()])),
      run: () => (async function *(): AsyncGenerator<AuthorizationFrame> {
        yield { type: 'started', attemptId: 'attempt-2', key: 'llm-pi-ai/openai-codex' }
        yield { type: 'failed', code: 'OAUTH', message: 'provider exploded' }
      })(),
      answer: () => Promise.resolve({ ok: true, value: { accepted: true } }),
      cancel: () => Promise.resolve({ ok: true, value: { cancelled: true } }),
    }
    mount(remote)
    await waitFor(() => { expect(screen.getByText('Codex')).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authSignIn }))
    })
    await waitFor(() => { expect(screen.getByText('provider exploded')).toBeTruthy() })
    expect(screen.getByText('Codex')).toBeTruthy()
  })

  it('sends one answer for a double submit', async () => {
    const gate = deferred<string>()
    const answer = vi.fn((_request: { attemptId: string; promptId: string; value: string }) => {
      gate.resolve(_request.value)
      return Promise.resolve({ ok: true as const, value: { accepted: true } })
    })
    const remote: AuthorizationRemote = {
      list: () => Promise.resolve(flowsResponse([codexFlow()])),
      run: () => (async function *(): AsyncGenerator<AuthorizationFrame> {
        yield { type: 'started', attemptId: 'attempt-3', key: 'llm-pi-ai/openai-codex' }
        yield { type: 'prompt', promptId: 'prompt-3', prompt: { kind: 'text', message: 'Name?' } }
        await gate.promise
        yield { type: 'settled', status: 'authorized' }
      })(),
      answer,
      cancel: () => Promise.resolve({ ok: true, value: { cancelled: true } }),
    }
    mount(remote)
    await waitFor(() => { expect(screen.getByText('Codex')).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authSignIn }))
    })
    await waitFor(() => { expect(screen.getByText('Name?')).toBeTruthy() })
    const input = document.querySelector('label input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    await act(async () => {
      fireEvent.change(input!, { target: { value: 'typed' } })
      const form = input!.closest('form')!
      // The double submit: Enter plus an immediate second submit.
      fireEvent.submit(form)
      fireEvent.submit(form)
    })
    await waitFor(() => { expect(screen.getByText(en.authAuthorized)).toBeTruthy() })
    expect(answer).toHaveBeenCalledTimes(1)
  })

  it('holds the prompt when an answer is refused instead of failing', async () => {
    const gate = deferred<string>()
    let calls = 0
    const remote: AuthorizationRemote = {
      list: () => Promise.resolve(flowsResponse([codexFlow()])),
      run: () => (async function *(): AsyncGenerator<AuthorizationFrame> {
        yield { type: 'started', attemptId: 'attempt-4', key: 'llm-pi-ai/openai-codex' }
        yield { type: 'prompt', promptId: 'prompt-4', prompt: { kind: 'text', message: 'Name?' } }
        await gate.promise
        yield { type: 'settled', status: 'authorized' }
      })(),
      answer: () => {
        calls += 1
        // The first submit races a stale prompt and is refused; the retry is
        // accepted and releases the settlement.
        if (calls === 1) {
          return Promise.resolve({ ok: false as const, error: { message: 'no pending prompt' } })
        }
        gate.resolve('typed')
        return Promise.resolve({ ok: true as const, value: { accepted: true } })
      },
      cancel: () => Promise.resolve({ ok: true, value: { cancelled: true } }),
    }
    mount(remote)
    await waitFor(() => { expect(screen.getByText('Codex')).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authSignIn }))
    })
    await waitFor(() => { expect(screen.getByText('Name?')).toBeTruthy() })
    const input = document.querySelector('label input') as HTMLInputElement | null
    expect(input).not.toBeNull()
    await act(async () => {
      fireEvent.change(input!, { target: { value: 'typed' } })
      fireEvent.click(screen.getByRole('button', { name: en.authContinue }))
    })
    // The refusal is benign: the prompt stays for another try and the later
    // settlement still completes the attempt.
    await waitFor(() => { expect(screen.getByText('Name?')).toBeTruthy() })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: en.authContinue }))
    })
    await waitFor(() => { expect(screen.getByText(en.authAuthorized)).toBeTruthy() })
    expect(calls).toBe(2)
  })
})
