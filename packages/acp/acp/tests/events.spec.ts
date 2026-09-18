import { describe, expect, it } from 'vitest'
import { AgentEventFactory } from '@deepseek-ai/dsh-llm'
import { acpUpdateToAgentEvent } from '../src/events.ts'

describe('ACP canonical event projection', () => {
  it('maps thought, message, tool, and usage updates without dropping unknowns', () => {
    const factory = new AgentEventFactory({ streamId: 'acp-1', eventId: () => 'event-1' })
    expect(acpUpdateToAgentEvent({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'plan' } }, factory)).toMatchObject({ type: 'reasoning.delta', visibility: 'agent' })
    expect(acpUpdateToAgentEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } }, factory)).toMatchObject({ type: 'text.delta' })
    expect(acpUpdateToAgentEvent({ sessionUpdate: 'usage_update', used: 4, size: 8 }, factory)).toMatchObject({ type: 'usage' })
    expect(acpUpdateToAgentEvent({ sessionUpdate: 'future_update', value: 1 } as never, factory)).toMatchObject({ type: 'acp.future_update' })
  })
})
