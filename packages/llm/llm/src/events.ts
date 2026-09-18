/**
 * Provider-neutral event envelope for transports that need more than the
 * legacy `StreamChunk` union. The shape is intentionally wire-compatible
 * with Nimbus Atlas' `nimbus.agent-event` envelope, but this package remains
 * standalone so DSH can use it without importing Atlas.
 */

import { randomUUID } from 'node:crypto'
import type { StreamChunk } from './types.ts'

export const AGENT_EVENT_SCHEMA = 'nimbus.agent-event' as const
export const AGENT_EVENT_SCHEMA_VERSION = 1 as const

export type AgentEventVisibility = 'public' | 'user' | 'agent' | 'system' | 'debug' | 'secret'
export type AgentEventType =
  | 'input' | 'context' | 'text.delta' | 'reasoning.delta' | 'tool.call' | 'tool.result'
  | 'structured.delta' | 'structured.final' | 'citation' | 'audio.delta' | 'image' | 'video'
  | 'artifact' | 'usage' | 'status' | 'error' | 'control' | 'retrieval' | 'permission'
  | 'session' | 'handoff' | 'routing' | 'safety' | 'memory' | 'cache' | 'heartbeat'
  | 'cancel' | 'performance' | 'completion'
export type AgentEventName = AgentEventType | (string & {})

export interface AgentEventSource {
  system?: string
  provider?: string
  model?: string
  requestId?: string
  protocol?: string
}
export interface AgentEvent<T = unknown> {
  schema: typeof AGENT_EVENT_SCHEMA
  schemaVersion: typeof AGENT_EVENT_SCHEMA_VERSION
  eventId: string
  streamId: string
  sequence: number
  parentId?: string
  emittedAt: string
  type: AgentEventName
  visibility: AgentEventVisibility
  terminal?: boolean
  source?: AgentEventSource
  payload: T
}

export interface AgentEventFactoryOptions {
  streamId: string
  source?: AgentEventSource
  now?: () => Date
  eventId?: () => string
}

export class AgentEventFactory {
  private sequence = 0
  private readonly options: AgentEventFactoryOptions

  constructor(options: AgentEventFactoryOptions) {
    if (options.streamId.trim() === '') throw new TypeError('streamId must be non-empty')
    this.options = options
  }

  create<T>(type: AgentEventName, payload: T, options: {
    visibility?: AgentEventVisibility
    terminal?: boolean
    parentId?: string
    source?: AgentEventSource
  } = {}): AgentEvent<T> {
    const sequence = ++this.sequence
    return {
      schema: AGENT_EVENT_SCHEMA,
      schemaVersion: AGENT_EVENT_SCHEMA_VERSION,
      eventId: (this.options.eventId ?? randomUUID)(),
      streamId: this.options.streamId,
      sequence,
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      emittedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      type,
      visibility: options.visibility ?? 'public',
      ...(options.terminal ? { terminal: true } : {}),
      ...(this.options.source || options.source ? { source: { ...this.options.source, ...options.source } } : {}),
      payload,
    }
  }
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (value === null || typeof value !== 'object') return false
  const event = value as Partial<AgentEvent>
  return event.schema === AGENT_EVENT_SCHEMA
    && event.schemaVersion === AGENT_EVENT_SCHEMA_VERSION
    && typeof event.eventId === 'string' && event.eventId.length > 0
    && typeof event.streamId === 'string' && event.streamId.length > 0
    && Number.isSafeInteger(event.sequence) && (event.sequence as number) > 0
    && typeof event.emittedAt === 'string'
    && typeof event.type === 'string'
    && typeof event.visibility === 'string'
    && 'payload' in event
}

/** Losslessly project DSH's native stream vocabulary into the shared envelope. */
export function streamChunkToAgentEvent(
  chunk: StreamChunk,
  factory: AgentEventFactory,
): AgentEvent | undefined {
  switch (chunk.type) {
    case 'text-delta': return factory.create('text.delta', { text: chunk.text })
    case 'reasoning-delta': return factory.create('reasoning.delta', { text: chunk.text }, { visibility: 'agent' })
    case 'tool-call-delta': return factory.create('tool.call', {
      id: chunk.id,
      index: chunk.index,
      name: chunk.name,
      argumentsDelta: chunk.argumentsDelta,
    })
    case 'usage': return factory.create('usage', chunk.usage)
    case 'block-start': return factory.create('status', { state: 'block-start', index: chunk.index, blockType: chunk.blockType })
    case 'block-end': return factory.create('status', { state: 'block-end', index: chunk.index, block: chunk.block })
    case 'finish': {
      const type = chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted' ? 'error' : 'completion'
      return factory.create(type, { reason: chunk.reason, replayState: chunk.replayState }, { terminal: true })
    }
  }
}

/** Convert shared events back to the native DSH stream where a projection exists. */
export function agentEventToStreamChunk(event: AgentEvent, index = 0): StreamChunk | undefined {
  switch (event.type) {
    case 'text.delta': return { type: 'text-delta', index, text: textPayload(event.payload) }
    case 'reasoning.delta': return { type: 'reasoning-delta', index, text: textPayload(event.payload) }
    case 'usage': return isUsage(event.payload) ? { type: 'usage', usage: event.payload } : undefined
    default: return undefined
  }
}

function textPayload(value: unknown): string {
  return value !== null && typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string'
    ? (value as { text: string }).text
    : typeof value === 'string' ? value : ''
}

function isUsage(value: unknown): value is Extract<StreamChunk, { type: 'usage' }>['usage'] {
  return value !== null && typeof value === 'object'
    && typeof (value as { inputTokens?: unknown }).inputTokens === 'number'
    && typeof (value as { outputTokens?: unknown }).outputTokens === 'number'
}
