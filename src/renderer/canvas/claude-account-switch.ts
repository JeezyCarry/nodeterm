// "Switch Claude account" on a RUNNING node: move the conversation onto another account the user
// has already logged into, with no `/login` in the pane. The Claude counterpart of the Codex switch
// (`codex-account-ops.ts`), and much simpler: Claude's account IS its config dir, and a transcript
// carries no account identity, so the whole switch is
//
//   1. quit the CLI (the ordinary "Restart agent and shell" exit — refused while busy/blocked),
//   2. copy the transcript into the target account's dir (core `claudeAccounts.copySession`),
//   3. rebind the node's `accountId`, and
//   4. recycle the tmux session, whose respawn gets the new CLAUDE_CONFIG_DIR and whose cold-restore
//      auto-resume runs `claude --resume <same id>` under it.
//
// This file is the renderer's own fail-closed refusal of what cannot work; core re-checks the target.

import type { ClaudeAccount } from '@shared/types'

/** Accounts a node on THIS machine can be switched onto: settled, local (managed or linked). */
export function claudeSwitchTargets(accounts: readonly ClaudeAccount[]): ClaudeAccount[] {
  return accounts.filter((a) => !a.host && !a.pending)
}

export interface ClaudeSwitchNode {
  agentId?: string
  /** The account the node was launched under (`data.accountId`; undefined = system). */
  accountId?: string
  /** Where its transcript actually lives — `effectiveAccountId(...)`, the same id its readers use. */
  readAccountId?: string
  /** A remote (SSH) or relay session: its transcript and account dirs are on another machine. */
  remote: boolean
  sessionId?: string
}

export interface ClaudeSwitchPlan {
  sessionId: string
  sourceAccountId: string | undefined
  targetAccountId: string | undefined
}

export type ClaudeSwitchDecision =
  | { ok: true; plan: ClaudeSwitchPlan }
  | { ok: false; reason: 'not-claude' | 'remote' | 'no-session' | 'same-account' | 'unavailable' }

export function planClaudeAccountSwitch(
  node: ClaudeSwitchNode,
  targetAccountId: string | undefined,
  accounts: readonly ClaudeAccount[]
): ClaudeSwitchDecision {
  // The builtin only: `boundAccountId` (shared/agents/account-binding.ts) never binds an account to
  // any other agent — a custom agent on the claude harness included — so neither may a switch.
  if (node.agentId !== 'claude') return { ok: false, reason: 'not-claude' }
  if (node.remote) return { ok: false, reason: 'remote' }
  const target = targetAccountId || undefined
  if (target === (node.accountId || undefined)) return { ok: false, reason: 'same-account' }
  // Never substitute: a target that is gone, pending or on another host is refused, not swapped for
  // the system account.
  if (target !== undefined && !claudeSwitchTargets(accounts).some((a) => a.id === target))
    return { ok: false, reason: 'unavailable' }
  if (!node.sessionId) return { ok: false, reason: 'no-session' }
  return {
    ok: true,
    plan: {
      sessionId: node.sessionId,
      sourceAccountId: node.readAccountId || node.accountId || undefined,
      targetAccountId: target
    }
  }
}

/** The notice for a copy refusal. The pane still comes back (on the old account) either way. */
export function copyRefusalText(reason: string, targetLabel: string): string {
  const why =
    reason === 'diverged'
      ? `${targetLabel} already holds a different copy of this conversation`
      : reason === 'no-transcript'
        ? 'its transcript could not be found'
        : reason === 'unknown-account'
          ? `${targetLabel} is no longer available`
          : 'the transcript could not be copied'
  return `Could not move this conversation to ${targetLabel} — ${why}. It was resumed on its current account.`
}
