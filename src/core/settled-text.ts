import { sendKeysWrites } from '../session-host/send-keys-delivery'
import { sanitizePasteText } from './paste-injection'
import { ENVELOPE_SETTLE_POLLS, ENVELOPE_SETTLE_POLL_MS, type SettleOptions } from './settled-submit'

export interface TextPane {
  current(): boolean
  bracketed(): Promise<boolean>
  capture(): Promise<string | null>
  write(text: string): void
}

// Refuse overlapping calls before writing anything, including a second bare Enter. The host
// uses the session object as the key (across sockets); direct PTYs use their pane object.
const pending = new WeakSet<object>()
const visible = (text: string): string => text
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\s+/g, '')

/** True means text reached the PTY, NOT that the app accepted Enter. Never return false after
 * pasting: callers may retry false, duplicating the composer contents. No blind submit retry.
 * Generic text has no unique envelope footer, so require a changed, stable screen containing
 * the sanitized payload. Collapsed/hidden/oversize pastes may need the user's manual Enter. */
export async function sendTextWhenSettled(
  key: object, text: string, enter: boolean, pane: TextPane, options: SettleOptions = {}
): Promise<boolean> {
  if (pending.has(key) || !pane.current()) return false
  pending.add(key)
  let written = false
  try {
    const body = sanitizePasteText(text)
    const bracketed = body ? await pane.bracketed() : false
    if (!pane.current()) return false
    const capture = async (): Promise<string | null> => {
      if (!pane.current()) return null
      try {
        const value = await pane.capture()
        return pane.current() && value !== null ? visible(value) : null
      } catch { return null }
    }
    const settle = bracketed && enter && !!body
    const before = settle ? await capture() : null
    // The baseline await may have crossed an exit or a mode change.
    if (settle && !(await pane.bracketed())) return false
    if (!pane.current()) return false
    for (const chunk of sendKeysWrites(body, settle ? false : enter, bracketed)) {
      pane.write(chunk)
      written = true
    }
    if (!settle) return true
    const wait = options.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const polls = Math.min(ENVELOPE_SETTLE_POLLS, Math.max(1, options.polls ?? ENVELOPE_SETTLE_POLLS))
    const needle = visible(body)
    let previous: string | null = null
    for (let i = 0; i < polls; i++) {
      await wait(ENVELOPE_SETTLE_POLL_MS)
      if (!pane.current()) break
      const now = await capture()
      if (before !== null && needle && now !== null && now !== before && now.includes(needle)) {
        if (now === previous) {
          if (await pane.bracketed() && pane.current()) pane.write('\r')
          break
        }
        previous = now
      } else previous = null
    }
    return true
  } catch {
    return written
  } finally {
    pending.delete(key)
  }
}
