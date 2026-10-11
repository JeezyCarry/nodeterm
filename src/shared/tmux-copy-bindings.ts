/**
 * Mouse-copy bindings for tmux copy mode: the ONE definition both generated tmux configs use
 * (`tmuxConf` in core/pty-manager.ts and `remoteTmuxConf` in shared/ssh.ts), so the local socket
 * and an SSH host's socket cannot drift apart. They used to be six copy-pasted lines in each.
 *
 * On release, tmux copies the selection to its buffer and, because both configs set
 * `set-clipboard on` + `terminal-features ",*:clipboard"`, emits OSC 52, which the renderer writes
 * to the system clipboard. There is deliberately no pipe to a local command (`pbcopy` was
 * macOS-only, and over SSH it would run on the remote host).
 *
 * WHETHER THE COPY LEAVES COPY MODE depends on where the user is looking:
 *  - On the live screen (`#{scroll_position}` is 0): `copy-pipe-and-cancel`, which copies and exits
 *    copy mode. A plain drag enters copy mode at scroll position 0 (root `MouseDrag1Pane` →
 *    `copy-mode -M`), so staying in it would leave the pane in a mode that swallows the next
 *    keystroke or paste. A selection made on the live screen therefore behaves exactly as before.
 *  - Scrolled up into the history: `copy-pipe`, which copies, clears the highlight and STAYS in
 *    copy mode at the same position. `-and-cancel` here dropped the user back to the live screen
 *    mid-read. Panes whose app owns the mouse (Claude Code's fullscreen TUI) never reach these
 *    bindings, because tmux forwards the mouse to the app. Panes whose app leaves the mouse to tmux
 *    (Pi, Codex, plain shells) do.
 *
 * The cost of staying in copy mode: copy mode swallows typing and pastes. MEASURED on tmux 3.7c
 * through an attached client: a bracketed paste into a scrolled-up pane delivered zero bytes to the
 * app, and tmux has no bindable paste key (`bind -T copy-mode PasteStart …` → "unknown key"). That
 * was already true of any scrolled-up pane, selection or not; the user leaves copy mode by
 * scrolling back to the bottom (wheel entry uses `copy-mode -e`), `q` or Escape.
 *
 * `if-shell -F` evaluates a format with no fork. On a tmux that does not know `scroll_position`,
 * the format expands to '' and the binding falls back to `copy-pipe-and-cancel`, i.e. the old
 * behavior. `copy-pipe` clears the selection by default from tmux 3.0. Proven against a real tmux in
 * tmux-copy-bindings.realtmux.test.ts.
 */
export const COPY_ON_RELEASE =
  "if-shell -F '#{scroll_position}' 'send-keys -X copy-pipe' 'send-keys -X copy-pipe-and-cancel'"

/** The binding lines, for both copy-mode key tables (emacs and vi). Text as written to tmux.conf. */
export const MOUSE_COPY_BINDINGS = [
  `bind -T copy-mode    MouseDragEnd1Pane ${COPY_ON_RELEASE}`,
  `bind -T copy-mode-vi MouseDragEnd1Pane ${COPY_ON_RELEASE}`,
  `bind -T copy-mode    DoubleClick1Pane send-keys -X select-word \\; ${COPY_ON_RELEASE}`,
  `bind -T copy-mode-vi DoubleClick1Pane send-keys -X select-word \\; ${COPY_ON_RELEASE}`,
  `bind -T copy-mode    TripleClick1Pane send-keys -X select-line \\; ${COPY_ON_RELEASE}`,
  `bind -T copy-mode-vi TripleClick1Pane send-keys -X select-line \\; ${COPY_ON_RELEASE}`
].join('\n')
