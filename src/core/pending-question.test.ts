import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeClaude } from '../shared/agents/normalize'
import { parseToolResultIds } from './context-tail'
import { _resetForTest, _snapshot, _inboxSnapshot, recordAgentEvent, recordRawToolEvent,
  recordQuestionResult, ignoreQuestionHook, STASH_MAX_AGE_MS, sweepStaleWorking } from './agent-status-mirror'

function hook(hook_event_name: string, extra: Record<string, unknown> = {}) {
  const payload = { hook_event_name, session_id: 'parent', ...extra }
  recordRawToolEvent('node', payload)
  const event = normalizeClaude({ nodeId: 'node', agentId: 'claude', payload })
  return event ? recordAgentEvent({ ...event, verified: true }) : null
}
function ask(id = 'ask-1') {
  return hook('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: id,
    tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } })
}
beforeEach(() => { _resetForTest(); vi.useFakeTimers(); vi.setSystemTime(100000) })
afterEach(() => { _resetForTest(); vi.useRealTimers() })

describe('Claude pending question correlation (#821)', () => {
  it('keeps attention and the inbox open through unrelated and child activity beyond stash freshness', () => {
    ask()
    vi.setSystemTime(Date.now() + STASH_MAX_AGE_MS + 1)
    for (const extra of [{ tool_name: 'Bash' }, { tool_name: 'Read', session_id: 'child' }]) {
      expect(hook('PreToolUse', extra)?.state).toBe('waiting')
    }
    expect(ignoreQuestionHook('node', { session_id: 'child' })).toBe(true)
    expect(ignoreQuestionHook('node', { session_id: 'parent' })).toBe(false)
    expect(hook('PreToolUse', { tool_name: 'Bash', agent_id: 'child' })).toBeNull()
    expect(hook('Stop')?.state).toBe('waiting')
    expect(hook('Notification', { notification_type: 'permission_prompt' })?.state).toBe('waiting')
    expect(hook('UserPromptSubmit', { prompt: '<task-notification>done</task-notification>' })?.state).toBe('waiting')
    sweepStaleWorking(Date.now() + 30 * 60000)
    expect(_snapshot().node).toMatchObject({ state: 'waiting', sessionId: 'parent' })
    expect(_inboxSnapshot().events).toHaveLength(1)
    expect(_inboxSnapshot().events[0].resolved).not.toBe(true)
  })

  it('matches session and tool ID for hooks, including a delayed answer to an older question', () => {
    ask()
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'other' })?.state).toBe('waiting')
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', session_id: 'child' })?.state).toBe('waiting')
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1' })?.state).toBe('working')
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
    ask('ask-2')
    expect(hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask-1' })?.state).toBe('waiting')
  })

  it.each(['User declined to answer questions', 'A'])('rescues the matching transcript result: %s', content => {
    ask()
    const ids = parseToolResultIds(JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'unrelated', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'ask-1', content }
    ] } }))
    expect(ids).toEqual(['unrelated', 'ask-1'])
    expect(recordQuestionResult('node', 'parent', ids[0])).toBeUndefined()
    expect(recordQuestionResult('node', 'other-session', ids[1])).toBeUndefined()
    expect(recordQuestionResult('node', 'parent', ids[1])?.state).toBe('working')
    expect(recordQuestionResult('node', 'parent', ids[1])).toBeUndefined()
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it.each(['UserPromptSubmit', 'SessionEnd', 'SessionStart', 'Stop'])('allows explicit reset: %s', event => {
    ask()
    hook(event, { is_interrupt: true, ...(event === 'SessionStart' ? { session_id: 'new' } : {}) })
    expect(_snapshot().node.pendingQuestion).toBeUndefined()
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it('does not let a transcript result dismiss an approval without a tracked question', () => {
    hook('PermissionRequest', { tool_name: 'Bash' })
    expect(recordQuestionResult('node', 'parent', 'tool')).toBeUndefined()
    expect(_snapshot().node.state).toBe('blocked')
  })
})

describe('subagent attention forwarding (W2)', () => {
  it.each(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])('filters child %s without changing a blocked parent', event => {
    hook('PermissionRequest', { tool_name: 'Bash' })
    expect(hook(event, { agent_id: 'child', tool_name: 'Bash' })).toBeNull()
    expect(_snapshot().node.state).toBe('blocked')
  })

  it.each(['allow', 'deny'])('forwards a child approval ticket, summary and %s reply', decision => {
    const approval = { agent_id: 'child', tool_name: 'Bash', tool_input: { command: 'echo child' }, nodeterm_pending_id: 'node-1-1' }
    expect(hook('PermissionRequest', approval)).toMatchObject({ state: 'blocked', pendingId: 'node-1-1', askKind: 'approval' })
    expect(_inboxSnapshot().events[0]).toMatchObject({ kind: 'approval', pendingId: 'node-1-1' })
    expect(_inboxSnapshot().events[0].resolved).not.toBe(true)
    expect(JSON.stringify(_inboxSnapshot().events[0])).toContain('echo child')
    expect(hook('PermissionRequest', { ...approval, nodeterm_answered: decision })).toMatchObject({ state: 'working', pendingId: 'node-1-1' })
    expect(_inboxSnapshot().events[0].resolved).toBe(true)
  })

  it('forwards child permission notifications and ignores informational notifications', () => {
    expect(hook('Notification', { agent_id: 'child', notification_type: 'permission_prompt' })?.state).toBe('blocked')
    expect(hook('Notification', { agent_id: 'child', notification_type: 'auth_success' })).toBeNull()
    expect(_snapshot().node.state).toBe('blocked')
  })
})
