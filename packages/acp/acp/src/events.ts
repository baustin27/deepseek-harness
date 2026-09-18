/** ACP → Nimbus canonical event projection.
 *
 * ACP remains the native wire protocol. This adapter lets DSH clients and
 * gateways consume the same lossless event envelope as Atlas without adding
 * non-standard ACP update methods to the SDK.
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { AgentEventFactory, type AgentEvent } from '@deepseek-ai/dsh-llm'

export function acpUpdateToAgentEvent(
  update: SessionUpdate,
  factory: AgentEventFactory,
): AgentEvent | undefined {
  const value = update as unknown as Record<string, unknown>
  const name = typeof value.sessionUpdate === 'string' ? value.sessionUpdate : 'unknown'
  const content = value.content
  if (name === 'agent_message_chunk' && isTextContent(content)) {
    return factory.create('text.delta', { text: content.text })
  }
  if (name === 'agent_thought_chunk' && isTextContent(content)) {
    return factory.create('reasoning.delta', { text: content.text }, { visibility: 'agent' })
  }
  if (name === 'tool_call') return factory.create('tool.call', value)
  if (name === 'tool_call_update') return factory.create('tool.result', value)
  if (name === 'usage_update') return factory.create('usage', value)
  if (name === 'config_option_update') return factory.create('control', value)
  return factory.create(`acp.${name}`, value)
}

function isTextContent(value: unknown): value is { type: 'text'; text: string } {
  return value !== null && typeof value === 'object'
    && (value as { type?: unknown }).type === 'text'
    && typeof (value as { text?: unknown }).text === 'string'
}
