import { describe, expect, it } from 'vitest'
import { piBranchCommand } from './piBranch'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('piBranchCommand', () => {
  it('forks the current head into a caller-owned session with the node name', () => {
    expect(
      piBranchCommand(
        'pi',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        "Fix user's bug (branch)"
      )
    ).toBe(
      "pi --fork 11111111-1111-4111-8111-111111111111 --session-id 22222222-2222-4222-8222-222222222222 --name 'Fix user'\\''s bug (branch)'"
    )
  })

  it('rejects session ids that could inject shell arguments', () => {
    expect(piBranchCommand('pi', 'bad; rm -rf ~', 'new-id', 'branch')).toBeNull()
    expect(piBranchCommand('pi', 'source-id', 'bad; rm -rf ~', 'branch')).toBeNull()
  })
})

describe('Pi branch wiring', () => {
  const canvas = readFileSync(path.join(__dirname, '../canvas/Canvas.tsx'), 'utf8')
  const start = canvas.indexOf('const branchConversation = useCallback(')
  const body = canvas.slice(start, canvas.indexOf('const transferConversation = useCallback(', start))

  it('forks Pi without mutating the source terminal', () => {
    const pi = body.slice(body.indexOf("if (grammar === 'pi'"), body.indexOf('} else {'))
    expect(pi).toContain('piBranchCommand(')
    expect(pi).toContain('agentSessionId: newSessionId')
    expect(pi).not.toContain("sendText(nodeId, '/branch')")
  })
})
