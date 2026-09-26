/**
 * Browser sign-in section for account-based provider logins. Lists the host
 * authorization flows, runs one attempt at a time as a streamed frame
 * conversation, and renders notices, prompts, and the terminal outcome. The
 * grant itself never crosses here: answers travel to the flow, the record
 * stays in the host credential store.
 *
 * @module @deepseek-ai/dsh-client-ui-settings-models/src/client/AuthorizationSection.tsx
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import styles from './ModelsSection.module.css'
import { en } from './locales.ts'

/** One browser-safe method offered by an authorization flow. */
export interface AuthorizationMethodView {
  readonly id: string
  readonly label: string
}

/** One browser-safe view of a host authorization flow. */
export interface AuthorizationFlowView {
  readonly key: string
  readonly label: string
  readonly methods: readonly AuthorizationMethodView[]
  readonly configured: boolean
  readonly inFlight: boolean
}

/** One browser-safe select option for an authorization prompt. */
export interface AuthorizationPromptOptionView {
  readonly id: string
  readonly label: string
  readonly description?: string
}

/** One browser-safe authorization prompt. */
export type AuthorizationPromptView = {
  readonly message: string
  readonly placeholder?: string
} & ({
  readonly kind: 'text' | 'secret'
} | {
  readonly kind: 'select'
  readonly options: readonly AuthorizationPromptOptionView[]
})

/** One frame of a running browser authorization attempt. */
export type AuthorizationFrame =
  | { readonly type: 'started'; readonly attemptId: string; readonly key: string }
  | {
    readonly type: 'notice'
    readonly notice: { readonly message: string; readonly url?: string; readonly code?: string }
  }
  | { readonly type: 'prompt'; readonly promptId: string; readonly prompt: AuthorizationPromptView }
  | { readonly type: 'settled'; readonly status: 'authorized' | 'cancelled' }
  | { readonly type: 'failed'; readonly code?: string; readonly message: string }

/** Failure envelope the generated Remote client answers refused calls with. */
export interface AuthorizationRemoteFailure {
  readonly message: string
}

/** The Host `authorization` Remote namespace as this section consumes it. */
export interface AuthorizationRemote {
  list(): Promise<
    | { readonly ok: true; readonly value: readonly AuthorizationFlowView[] }
    | { readonly ok: false; readonly error: AuthorizationRemoteFailure }
  >
  run(
    request: { readonly key: string; readonly method?: string },
    signal: AbortSignal,
  ): AsyncIterable<AuthorizationFrame>
  answer(request: { readonly attemptId: string; readonly promptId: string; readonly value: string }): Promise<
    | { readonly ok: true; readonly value: { readonly accepted: true } }
    | { readonly ok: false; readonly error: AuthorizationRemoteFailure }
  >
  cancel(request: { readonly attemptId: string }): Promise<
    | { readonly ok: true; readonly value: { readonly cancelled: true } }
    | { readonly ok: false; readonly error: AuthorizationRemoteFailure }
  >
}

export interface AuthorizationSectionProps {
  /** Host authorization Remote; the section hides when the composition omits it. */
  readonly remote: AuthorizationRemote
  /** Section copy. */
  readonly t: (key: keyof typeof en) => string
}

interface ActiveAttempt {
  readonly key: string
  readonly method: string
  attemptId: string | undefined
  readonly controller: AbortController
  readonly notices: readonly { readonly message: string; readonly url?: string; readonly code?: string }[]
  readonly prompt: { readonly promptId: string; readonly prompt: AuthorizationPromptView } | undefined
  readonly outcome: 'authorized' | 'cancelled' | 'failed' | undefined
  readonly failure: string | undefined
  readonly busy: boolean
}

/** Render one notice: the message, the page it names, and the code it carries. */
function Notice({ notice, openLinkLabel }: {
  readonly notice: { readonly message: string; readonly url?: string; readonly code?: string }
  readonly openLinkLabel: string
}): ReactNode {
  return (
    <div className={styles['authNotice']}>
      <p>{notice.message}</p>
      {notice.url === undefined
        ? null
        : <a href={notice.url} target="_blank" rel="noreferrer">{openLinkLabel}</a>}
      {notice.code === undefined ? null : <code>{notice.code}</code>}
    </div>
  )
}

/** Render the active prompt with its answer control. */
function AttemptPrompt({ attempt, t, onAnswer, disabled }: {
  readonly attempt: ActiveAttempt
  readonly t: (key: keyof typeof en) => string
  readonly onAnswer: (value: string) => void
  readonly disabled: boolean
}): ReactNode {
  const prompt = attempt.prompt
  if (prompt === undefined) return null
  if (prompt.prompt.kind === 'select') {
    return (
      <form
        className={styles['authPrompt']}
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          const value = data.get('authorization-answer')
          if (typeof value === 'string' && value.length > 0) onAnswer(value)
        }}
      >
        <label className={styles['authPromptLabel']}>
          {prompt.prompt.message}
          <select
            name="authorization-answer"
            className={`${styles['input']} ${styles['selectInput']}`}
            defaultValue={prompt.prompt.options[0]?.id ?? ''}
            disabled={disabled}
          >
            {prompt.prompt.options.map(option => (
              <option key={option.id} value={option.id} title={option.description}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className={styles['secondaryButton']} disabled={disabled}>
          {t('authContinue')}
        </button>
      </form>
    )
  }
  return (
    <form
      className={styles['authPrompt']}
      onSubmit={(event) => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        const value = data.get('authorization-answer')
        if (typeof value === 'string') onAnswer(value)
      }}
    >
      <label className={styles['authPromptLabel']}>
        {prompt.prompt.message}
        <input
          name="authorization-answer"
          className={styles['input']}
          type={prompt.prompt.kind === 'secret' ? 'password' : 'text'}
          placeholder={prompt.prompt.placeholder}
          autoComplete="off"
          disabled={disabled}
        />
      </label>
      <button type="submit" className={styles['secondaryButton']} disabled={disabled}>
        {t('authContinue')}
      </button>
    </form>
  )
}

/**
 * Account sign-in section. One attempt runs at a time across all flows: the
 * seam refuses a second attempt for a busy key, and the section keeps the
 * conversation readable by starting no other while one is open.
 */
export function AuthorizationSection({ remote, t }: AuthorizationSectionProps): ReactNode {
  const [flows, setFlows] = useState<readonly AuthorizationFlowView[] | undefined>(undefined)
  const [loadFailure, setLoadFailure] = useState<string | undefined>(undefined)
  const [methods, setMethods] = useState<Readonly<Record<string, string>>>({})
  const [active, setActive] = useState<ActiveAttempt | undefined>(undefined)
  const activeRef = useRef<ActiveAttempt | undefined>(undefined)
  activeRef.current = active

  const refresh = (): void => {
    void remote.list().then((response) => {
      if (!response.ok) {
        setLoadFailure(response.error.message)
        return
      }
      setLoadFailure(undefined)
      setFlows(response.value)
    }).catch((error: unknown) => {
      setLoadFailure(error instanceof Error ? error.message : String(error))
    })
  }

  useEffect(() => {
    refresh()
    return () => {
      activeRef.current?.controller.abort()
    }
    // Mount-only: the remote is composition-stable for the page lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stopAttempt = (outcome: 'authorized' | 'cancelled' | 'failed', failure?: string): void => {
    setActive((current) => {
      if (current === undefined) return current
      current.controller.abort()
      return { ...current, prompt: undefined, outcome, failure, busy: false }
    })
    refresh()
  }

  const cancelAttempt = (): void => {
    const current = activeRef.current
    if (current === undefined || current.outcome !== undefined) return
    setActive({ ...current, busy: true })
    const attemptId = current.attemptId
    if (attemptId !== undefined) {
      void remote.cancel({ attemptId }).catch(() => {
        // Withdrawing locally below is what ends the conversation; a refused
        // cancel only means the attempt already settled on its own.
      })
    }
    current.controller.abort()
    setActive(latest => latest === undefined ? latest : { ...latest, prompt: undefined, outcome: 'cancelled', busy: false })
    refresh()
  }

  const answerPrompt = (value: string): void => {
    const current = activeRef.current
    const prompt = current?.prompt
    const attemptId = current?.attemptId
    if (current === undefined || prompt === undefined || attemptId === undefined || current.outcome !== undefined) return
    setActive({ ...current, busy: true })
    void remote.answer({ attemptId, promptId: prompt.promptId, value }).then((response) => {
      if (!response.ok) {
        stopAttempt('failed', response.error.message)
        return
      }
      // The answer was accepted; the next frame arrives on the open stream.
      // Clear the prompt optimistically so a repeated submit cannot double-send.
      setActive(latest => latest === undefined ? latest : { ...latest, prompt: undefined, busy: false })
    }).catch((error: unknown) => {
      stopAttempt('failed', error instanceof Error ? error.message : String(error))
    })
  }

  const startAttempt = (flow: AuthorizationFlowView): void => {
    if (activeRef.current !== undefined) return
    const method = methods[flow.key] ?? flow.methods[0]?.id ?? ''
    const controller = new AbortController()
    const attempt: ActiveAttempt = {
      key: flow.key,
      method,
      attemptId: undefined,
      controller,
      notices: [],
      prompt: undefined,
      outcome: undefined,
      failure: undefined,
      busy: true,
    }
    setActive(attempt)
    activeRef.current = attempt
    void (async () => {
      try {
        for await (const frame of remote.run(
          { key: flow.key, ...method === '' ? {} : { method } },
          controller.signal,
        )) {
          if (controller.signal.aborted) return
          if (frame.type === 'started') {
            setActive(current => current === undefined ? current : { ...current, attemptId: frame.attemptId, busy: false })
          } else if (frame.type === 'notice') {
            const notice = frame.notice
            setActive(current => current === undefined
              ? current
              : { ...current, notices: [...current.notices, notice] })
          } else if (frame.type === 'prompt') {
            const prompt = { promptId: frame.promptId, prompt: frame.prompt }
            setActive(current => current === undefined ? current : { ...current, prompt, busy: false })
          } else if (frame.type === 'settled') {
            stopAttempt(frame.status)
            return
          } else {
            stopAttempt('failed', frame.message)
            return
          }
        }
        // The stream ended with no terminal frame: the Host guarantees one, so
        // its absence reads as a transport break, not a quiet success.
        stopAttempt('failed', t('authFailure'))
      } catch (error: unknown) {
        if (controller.signal.aborted) return
        stopAttempt('failed', error instanceof Error ? error.message : String(error))
      }
    })()
  }

  if (flows === undefined) {
    return (
      <div className={styles['authSection']}>
        <div className={styles['authHeading']}>
          <h3 className={styles['authTitle']}>{t('authTitle')}</h3>
          <p className={styles['authMeta']}>{t('authLoading')}</p>
        </div>
      </div>
    )
  }
  if (flows.length === 0) return null

  return (
    <div className={styles['authSection']}>
      <div className={styles['authHeading']}>
        <h3 className={styles['authTitle']}>{t('authTitle')}</h3>
        <p className={styles['authMeta']}>{t('authIntro')}</p>
      </div>
      {loadFailure === undefined ? null : <p className={styles['error']}>{loadFailure}</p>}
      <ul className={styles['authRows']}>
        {flows.map(flow => (
          <li key={flow.key} className={styles['authRow']}>
            <div className={styles['authIdentity']}>
              <span className={styles['authName']}>{flow.label}</span>
              {flow.configured
                ? <span className={styles['authConnected']}>{t('authConnected')}</span>
                : <span className={styles['authMissing']}>{t('authMissing')}</span>}
            </div>
            <div className={styles['authActions']}>
              {flow.methods.length > 1
                ? (
                  <label className={styles['authPromptLabel']}>
                    {t('authMethod')}
                    <select
                      className={`${styles['input']} ${styles['selectInput']} ${styles['authMethod']}`}
                      value={methods[flow.key] ?? flow.methods[0]?.id ?? ''}
                      disabled={active !== undefined}
                      onChange={(event) => {
                        const method = event.currentTarget.value
                        setMethods(previous => ({ ...previous, [flow.key]: method }))
                      }}
                    >
                      {flow.methods.map(method => (
                        <option key={method.id} value={method.id}>{method.label}</option>
                      ))}
                    </select>
                  </label>
                )
                : null}
              <button
                type="button"
                className={styles['secondaryButton']}
                disabled={active !== undefined || flow.inFlight}
                onClick={() => { startAttempt(flow) }}
              >
                {active?.key === flow.key ? t('authSigningIn') : t('authSignIn')}
              </button>
              {active?.key === flow.key && active.outcome === undefined
                ? (
                  <button type="button" className={styles['secondaryButton']} onClick={cancelAttempt}>
                    {t('authCancel')}
                  </button>
                )
                : null}
            </div>
            {active?.key === flow.key
              ? (
                <div className={styles['authAttempt']}>
                  {active.notices.map((notice, index) => (
                    <Notice key={index} notice={notice} openLinkLabel={t('authOpenLink')} />
                  ))}
                  <AttemptPrompt attempt={active} t={t} onAnswer={answerPrompt} disabled={active.busy} />
                  {active.outcome === 'authorized'
                    ? <p className={styles['authMeta']}>{t('authAuthorized')}</p>
                    : active.outcome === 'cancelled'
                      ? <p className={styles['authMeta']}>{t('authCancelled')}</p>
                      : active.outcome === 'failed'
                        ? <p className={styles['error']}>{active.failure ?? t('authFailure')}</p>
                        : null}
                </div>
              )
              : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
