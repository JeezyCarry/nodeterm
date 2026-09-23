import { describe, it, expect } from 'vitest'
import type { ClaudeAccount } from '@shared/types'
import { claudeSwitchTargets, planClaudeAccountSwitch } from './claude-account-switch'

const acct = (id: string, extra: Partial<ClaudeAccount> = {}): ClaudeAccount => ({
  id,
  label: id,
  createdAt: 0,
  ...extra
})
const accounts = [acct('a'), acct('b'), acct('pend', { pending: true }), acct('rem', { host: 'u@h' })]
const node = { agentId: 'claude', accountId: 'a', remote: false, sessionId: 'sid-1' }

describe('claudeSwitchTargets', () => {
  it('offers only settled accounts on the node\'s own machine', () => {
    expect(claudeSwitchTargets(accounts).map((x) => x.id)).toEqual(['a', 'b'])
    const hosted = [...accounts, acct('rem2', { host: 'u@h' }), acct('other', { host: 'x@y' })]
    expect(claudeSwitchTargets(hosted, 'u@h').map((x) => x.id)).toEqual(['rem', 'rem2'])
  })
})

describe('planClaudeAccountSwitch — SSH', () => {
  const ssh = { agentId: 'claude', accountId: 'rem', remote: false, hostKey: 'u@h', sessionId: 's' }
  const hosted = [...accounts, acct('rem2', { host: 'u@h' }), acct('other', { host: 'x@y' })]
  it('switches between accounts pinned to the node\'s host, and to the host system dir', () => {
    expect(planClaudeAccountSwitch(ssh, 'rem2', hosted)).toEqual({
      ok: true,
      plan: { sessionId: 's', sourceAccountId: 'rem', targetAccountId: 'rem2' }
    })
    expect(planClaudeAccountSwitch(ssh, undefined, hosted)).toMatchObject({ ok: true })
  })
  it('refuses a local account or another host\'s account for an SSH node', () => {
    expect(planClaudeAccountSwitch(ssh, 'a', hosted)).toEqual({ ok: false, reason: 'unavailable' })
    expect(planClaudeAccountSwitch(ssh, 'other', hosted)).toEqual({ ok: false, reason: 'unavailable' })
  })
})

describe('planClaudeAccountSwitch', () => {
  it('plans a switch that resumes the SAME conversation id', () => {
    expect(planClaudeAccountSwitch(node, 'b', accounts)).toEqual({
      ok: true,
      plan: { sessionId: 'sid-1', sourceAccountId: 'a', targetAccountId: 'b' }
    })
  })

  it('switches to and from the system account (undefined)', () => {
    expect(planClaudeAccountSwitch(node, undefined, accounts)).toMatchObject({
      ok: true,
      plan: { targetAccountId: undefined }
    })
    expect(
      planClaudeAccountSwitch({ ...node, accountId: undefined }, 'b', accounts)
    ).toMatchObject({ ok: true, plan: { sourceAccountId: undefined, targetAccountId: 'b' } })
  })

  it('reads the transcript from where the readers look (the observed account)', () => {
    expect(
      planClaudeAccountSwitch({ ...node, accountId: undefined, readAccountId: 'a' }, 'b', accounts)
    ).toMatchObject({ ok: true, plan: { sourceAccountId: 'a' } })
  })

  it('refuses — never substitutes — what cannot work', () => {
    const r = (n: Partial<typeof node> & { readAccountId?: string }, t: string | undefined) =>
      planClaudeAccountSwitch({ ...node, ...n }, t, accounts)
    expect(r({ agentId: 'codex' }, 'b')).toEqual({ ok: false, reason: 'not-claude' })
    // A custom agent on the claude harness never carries an account (boundAccountId).
    expect(r({ agentId: 'my-claude-wrapper' }, 'b')).toEqual({ ok: false, reason: 'not-claude' })
    expect(r({ remote: true }, 'b')).toEqual({ ok: false, reason: 'remote' })
    expect(r({}, 'a')).toEqual({ ok: false, reason: 'same-account' })
    expect(r({}, 'pend')).toEqual({ ok: false, reason: 'unavailable' })
    expect(r({}, 'rem')).toEqual({ ok: false, reason: 'unavailable' })
    expect(r({}, 'gone')).toEqual({ ok: false, reason: 'unavailable' })
    expect(r({ sessionId: undefined as unknown as string }, 'b')).toEqual({
      ok: false,
      reason: 'no-session'
    })
  })
})
