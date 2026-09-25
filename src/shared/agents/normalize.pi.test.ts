import { describe, expect, it } from 'vitest'
import { normalizePi, type RawHookEnvelope } from './normalize'

const event = (payload: Record<string, unknown>): RawHookEnvelope => ({
  nodeId: 'node-1',
  agentId: 'pi',
  payload: { session_id: 'session-1', ...payload }
})

describe('normalizePi', () => {
  it('tracks session identity and names', () => {
    expect(normalizePi(event({ event: 'session_start', session_name: 'Build Pi' }))).toEqual({
      nodeId: 'node-1',
      agentId: 'pi',
      sessionId: 'session-1',
      kind: 'session',
      sessionPhase: 'start',
      sessionTitle: 'Build Pi'
    })
    expect(normalizePi(event({ event: 'session_info_changed', session_name: 'Rename Pi' }))).toEqual({
      nodeId: 'node-1',
      agentId: 'pi',
      sessionId: 'session-1',
      kind: 'session',
      sessionTitle: 'Rename Pi'
    })
  })

  it('maps turn and blocking prompt lifecycle', () => {
    expect(normalizePi(event({ event: 'before_agent_start' }))).toMatchObject({
      state: 'working',
      newTurn: true
    })
    expect(normalizePi(event({ event: 'ui_prompt_start', message: 'Choose' }))).toMatchObject({
      state: 'blocked',
      lastMessage: 'Choose'
    })
    expect(normalizePi(event({ event: 'ui_prompt_end' }))).toMatchObject({ state: 'working' })
    expect(normalizePi(event({ event: 'agent_settled', stop_reason: 'end_turn' }))).toMatchObject({
      state: 'done',
      interrupted: false,
      errored: false
    })
    expect(normalizePi(event({ event: 'agent_settled', stop_reason: 'aborted' }))).toMatchObject({
      state: 'done',
      interrupted: true,
      errored: false
    })
    expect(normalizePi(event({ event: 'agent_settled', stop_reason: 'error' }))).toMatchObject({
      state: 'done',
      interrupted: false,
      errored: true
    })
  })

  it('maps pi-subagents-lite lifecycle events', () => {
    expect(
      normalizePi(
        event({
          event: 'subagent_start',
          subagent_id: 'tool-1',
          subagent_type: 'luna-patch',
          task_label: 'Fix names'
        })
      )
    ).toMatchObject({
      kind: 'subagent-start',
      toolUseId: 'tool-1',
      subagentType: 'luna-patch',
      taskLabel: 'Fix names'
    })
    expect(
      normalizePi(
        event({
          event: 'subagent_end',
          subagent_id: 'tool-1',
          duration_ms: 25,
          tokens: 15,
          tool_uses: 2,
          result: 'Done'
        })
      )
    ).toMatchObject({
      kind: 'subagent-end',
      toolUseId: 'tool-1',
      durationMs: 25,
      tokens: 15,
      toolUses: 2,
      result: 'Done'
    })
    expect(normalizePi(event({ event: 'subagent_update', subagent_id: 'tool-1' }))).toBeNull()
  })

  it('ends only when Pi itself quits', () => {
    expect(normalizePi(event({ event: 'session_shutdown', reason: 'reload' }))).toBeNull()
    expect(normalizePi(event({ event: 'session_shutdown', reason: 'quit' }))).toMatchObject({
      kind: 'session',
      sessionPhase: 'end'
    })
  })
})
