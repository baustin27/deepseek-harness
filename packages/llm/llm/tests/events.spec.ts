import { describe, expect, it } from 'vitest'
import {
  AgentEventFactory,
  agentEventToStreamChunk,
  isAgentEvent,
  streamChunkToAgentEvent,
} from '../src/events.ts'

describe('canonical agent events', () => {
  it('projects text and provider-exposed reasoning without losing stream order', () => {
    const factory = new AgentEventFactory({ streamId: 'turn-1', now: () => new Date('2026-09-18T00:00:00Z'), eventId: () => 'evt' })
    const text = streamChunkToAgentEvent({ type: 'text-delta', index: 0, text: 'hello' }, factory)
    const reasoning = streamChunkToAgentEvent({ type: 'reasoning-delta', index: 1, text: 'plan' }, factory)
    expect(text).toMatchObject({ type: 'text.delta', sequence: 1, payload: { text: 'hello' } })
    expect(reasoning).toMatchObject({ type: 'reasoning.delta', sequence: 2, visibility: 'agent' })
    expect(isAgentEvent(text)).toBe(true)
  })

  it('keeps terminal completion separate from visible text', () => {
    const factory = new AgentEventFactory({ streamId: 'turn-2', eventId: () => 'evt' })
    const event = streamChunkToAgentEvent({ type: 'finish', reason: { kind: 'stop' } }, factory)
    expect(event).toMatchObject({ type: 'completion', terminal: true, payload: { reason: { kind: 'stop' } } })
  })

  it('projects compatible events back to native DSH chunks', () => {
    const factory = new AgentEventFactory({ streamId: 'turn-3', eventId: () => 'evt' })
    const event = factory.create('reasoning.delta', { text: 'thinking' })
    expect(agentEventToStreamChunk(event, 2)).toEqual({ type: 'reasoning-delta', index: 2, text: 'thinking' })
    expect(agentEventToStreamChunk(factory.create('artifact', { id: 'a' }))).toBeUndefined()
  })
})
