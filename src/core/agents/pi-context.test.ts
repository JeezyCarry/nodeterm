import { describe, expect, it } from 'vitest'
import { createPiContextReporter, piContextUsage } from './pi-context'

const payload = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: 'turn_end',
  session_id: 's-1',
  model: 'claude-opus-5-5',
  context_tokens: 12_000,
  context_window: 200_000,
  context_percent: 6,
  ...extra
})

describe('piContextUsage', () => {
  it('turns stated numbers into a ContextWindowUsage, preferring Pi’s own percentage', () => {
    expect(piContextUsage(payload(), 42)).toEqual({
      sessionId: 's-1',
      usedTokens: 12_000,
      windowTokens: 200_000,
      usedPercent: 6,
      model: 'claude-opus-5-5',
      windowSource: 'transcript',
      updatedAt: 42
    })
    expect(piContextUsage(payload({ context_percent: undefined }))?.usedPercent).toBe(6)
  })

  it('states nothing without a session, a token count or a window', () => {
    expect(piContextUsage(payload({ session_id: undefined }))).toBeUndefined()
    // Pi's "unknown until the next response" after a compaction arrives as an absent count.
    expect(piContextUsage(payload({ context_tokens: undefined }))).toBeUndefined()
    expect(piContextUsage(payload({ context_window: 0 }))).toBeUndefined()
    expect(piContextUsage(payload({ context_tokens: Number.NaN }))).toBeUndefined()
    expect(piContextUsage(payload({ context_tokens: -1 }))).toBeUndefined()
    expect(piContextUsage(null)).toBeUndefined()
  })

  it('clamps the percentage and drops a model label that is not a short printable string', () => {
    expect(piContextUsage(payload({ context_percent: 140 }))?.usedPercent).toBe(100)
    expect(piContextUsage(payload({ model: 'a\u0007b' }))?.model).toBeNull()
    expect(piContextUsage(payload({ model: 'x'.repeat(201) }))?.model).toBeNull()
    expect(piContextUsage(payload({ model: 7 }))?.model).toBeNull()
  })
})

describe('createPiContextReporter', () => {
  it('pushes a reading once, again only when it changes, and anew after forget', () => {
    const pushed: number[] = []
    const reporter = createPiContextReporter((u) => pushed.push(u.usedTokens))
    reporter.observe(payload())
    reporter.observe(payload())
    reporter.observe(payload({ event: 'tool_execution_start', context_tokens: undefined }))
    reporter.observe(payload({ context_tokens: 13_000, context_percent: 6.5 }))
    reporter.forget('s-1')
    reporter.observe(payload({ context_tokens: 13_000, context_percent: 6.5 }))
    expect(pushed).toEqual([12_000, 13_000, 13_000])
  })
})
