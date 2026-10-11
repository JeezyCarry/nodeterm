// Pi's context meter numbers. Unlike claude/codex/gemini there is no transcript tail behind them:
// Pi exposes `ctx.getContextUsage()` + `ctx.model` to extensions, and the managed extension
// (hooks/pi.ts) forwards both on its turn-boundary POSTs. This turns one such payload into the
// `ContextWindowUsage` every other agent's tail pushes, so the Notch HUD, the renderer and the
// phone's context ring receive Pi's numbers through the same funnel. ONE definition, used by both
// shells' raw listeners (invariant 11).

import type { ContextWindowUsage } from '@shared/types'

const MODEL_MAX = 200

interface PiContextPayload {
  session_id?: unknown
  model?: unknown
  context_tokens?: unknown
  context_window?: unknown
  context_percent?: unknown
}

const finite = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/** A model id is a display label; anything that is not a short printable string is dropped. */
function modelLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > MODEL_MAX || /[\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

/**
 * The usage a Pi hook payload states, or undefined when it states none. Pi's own percentage is
 * preferred over a recomputed one (it is the number Pi's footer shows); the window must be known,
 * because a percentage over a guessed denominator is a wrong number presented as a fact. A null
 * token count (Pi's "unknown until the next response" after a compaction) arrives as absent and
 * yields nothing — the previous reading stands.
 */
export function piContextUsage(payload: unknown, now = Date.now()): ContextWindowUsage | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as PiContextPayload
  const sessionId = typeof p.session_id === 'string' && p.session_id ? p.session_id : undefined
  if (!sessionId) return undefined
  const usedTokens = finite(p.context_tokens)
  const windowTokens = finite(p.context_window)
  if (usedTokens === undefined || usedTokens < 0 || windowTokens === undefined || windowTokens <= 0)
    return undefined
  const stated = finite(p.context_percent)
  const raw = stated ?? (usedTokens / windowTokens) * 100
  const usedPercent = Math.min(100, Math.max(0, raw))
  return {
    sessionId,
    usedTokens,
    windowTokens,
    usedPercent,
    model: modelLabel(p.model),
    windowSource: 'transcript',
    updatedAt: now
  }
}

export interface PiContextReporter {
  /** Push the payload's usage if it states one that differs from this session's last push. */
  observe(payload: unknown): ContextWindowUsage | undefined
  forget(sessionId: string): void
}

/** Change-gated like the transcript tails: an unchanged reading is not re-broadcast. */
export function createPiContextReporter(push: (usage: ContextWindowUsage) => void): PiContextReporter {
  const last = new Map<string, string>()
  return {
    observe(payload) {
      const usage = piContextUsage(payload)
      if (!usage) return undefined
      const key = `${usage.usedTokens}|${usage.windowTokens}|${usage.usedPercent}|${usage.model ?? ''}`
      if (last.get(usage.sessionId) === key) return undefined
      last.set(usage.sessionId, key)
      push(usage)
      return usage
    },
    forget(sessionId) {
      last.delete(sessionId)
    }
  }
}
