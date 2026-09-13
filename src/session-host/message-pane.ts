import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sanitizePasteText } from '../core/paste-injection'
import { readWindowsConsoleOwner, sameNativeProcess } from './windows-pane-owner'

export interface MessagePaneSession {
  generation: string
  exited: boolean
  proc: { pid: number; write(data: string): void }
  messagePasteReady(): Promise<boolean>
}

/** The persistent host owns both the emulator and the generation. Never route this through the
 * main process's direct-PTY adapter: that object cannot observe a replacement inside this host.
 * Project grants, verified hooks, agent binary checks and receipts still belong to core. */
export function hostMessagePane(
  lookup: () => MessagePaneSession | undefined,
  probe = readWindowsConsoleOwner
) {
  const current = (s: MessagePaneSession): boolean => !s.exited && lookup() === s
  return {
    async owner(): Promise<PaneOwner | null> {
      const s = lookup()
      if (!s || !current(s)) return null
      const owner = await probe(s.proc.pid, s.generation)
      return current(s) ? owner : null
    },
    async pasteReady(): Promise<boolean> {
      const s = lookup()
      return !!s && current(s) && await s.messagePasteReady() && current(s)
    },
    async send(envelope: string, expected: PaneOwner | undefined): Promise<boolean> {
      const s = lookup()
      if (!s || !current(s) || !expected || typeof envelope !== 'string') return false
      const text = sanitizePasteText(envelope)
      if (!text || !(await s.messagePasteReady()) || !current(s)) return false
      const owner = await probe(s.proc.pid, s.generation)
      if (!current(s) || !sameNativeProcess(expected, owner)) return false
      // Cross the emulator barrier again after the OS probe: paste mode may have changed while
      // it was running. Check the registry again after EVERY await, then write synchronously.
      if (!(await s.messagePasteReady()) || !current(s)) return false
      try {
        s.proc.write(`\x1b[200~${text}\x1b[201~\r`)
        return true
      } catch { return false }
    }
  }
}
