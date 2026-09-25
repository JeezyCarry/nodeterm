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
    expect(normalizePi(event({ event: 'agent_settled' }))).toMatchObject({ state: 'done' })
  })

  it('ends only when Pi itself quits', () => {
    expect(normalizePi(event({ event: 'session_shutdown', reason: 'reload' }))).toBeNull()
    expect(normalizePi(event({ event: 'session_shutdown', reason: 'quit' }))).toMatchObject({
      kind: 'session',
      sessionPhase: 'end'
    })
  })
})
