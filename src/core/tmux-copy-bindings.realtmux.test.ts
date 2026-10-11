// MOUSE-COPY BINDINGS, PROVEN AGAINST A REAL TMUX.
//
// tmux-conf.test.ts / ssh.test.ts pin the text both configs ship. Whether tmux PARSES the
// conditional binding, and whether a copy made while scrolled up really stays in copy mode at the
// same position (while one made on the live screen still leaves it), is a property of tmux, so it
// is measured here with the EXACT command tmux stored from `tmuxConf()`: each case reads the
// binding back with `list-keys` and runs it with `source-file`. No mouse client is needed for
// that: with one session on the server, a command run from the command line targets its pane.
//
// What this suite cannot see is the OSC 52 sent to an attached client. That was measured through a
// real attached client on tmux 3.7c: `copy-pipe` and `copy-pipe-and-cancel` both emit it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxConf } from './pty-manager'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-copy-${process.pid}`
const SESSION = 'copy'

let tmp: string
let tmuxOk = false

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

function tryTmux(args: string[]): void {
  try {
    tmux(args)
  } catch {
    /* e.g. `send-keys -X cancel` on a pane that is not in a mode */
  }
}

function fmt(f: string): string {
  return tmux(['display-message', '-p', '-t', SESSION, f]).trim()
}

/** The binding line tmux reports for `key` in `table`. Lists the whole table and picks the line,
 *  because `list-keys -T <table> <key>` prints nothing on tmux 3.7c. */
function bindingLine(table: string, key: string): string {
  const line = tmux(['list-keys', '-T', table])
    .split('\n')
    .find((l) => new RegExp(`-T ${table}\\s+${key}\\s`).test(l))
  expect(line, `no ${key} binding in ${table}`).toBeDefined()
  return line!
}

/** Run the command tmux has bound to `key` in the copy-mode table, exactly as tmux stored it. */
function runBinding(key: string): void {
  const m = bindingLine('copy-mode', key).match(new RegExp(`${key}\\s+(.*)$`))
  expect(m).not.toBeNull()
  const file = path.join(tmp, `${key}.cmd`)
  // list-keys prints a command LIST with `\;` between commands (the form `bind` takes). At the top
  // level of a sourced file the separator is a bare `;`; left escaped it becomes an argument.
  fs.writeFileSync(file, `${m![1].replace(/ \\; /g, ' ; ')}\n`)
  tmux(['source-file', file])
}

/** Enter copy mode, optionally scrolled up into the history, with a fresh sentinel buffer on top. */
function enterCopyMode(scrollUp: number): void {
  tryTmux(['send-keys', '-t', SESSION, '-X', 'cancel'])
  tmux(['set-buffer', '--', 'SENTINEL'])
  tmux(['copy-mode', '-t', SESSION])
  if (scrollUp > 0) tmux(['send-keys', '-t', SESSION, '-X', '-N', String(scrollUp), 'scroll-up'])
}

function selectFourChars(): void {
  tmux(['send-keys', '-t', SESSION, '-X', 'begin-selection'])
  tmux(['send-keys', '-t', SESSION, '-X', '-N', '4', 'cursor-left'])
}

function copied(): string {
  return tmux(['show-buffer'])
}

beforeAll(async () => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntcopy-', SOCKET)
  const conf = path.join(tmp, 'copy.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
  tmux([
    '-f', conf, 'new-session', '-d', '-x', '80', '-y', '20', '-s', SESSION,
    "sh -c 'seq 1 300; sleep 120'"
  ])
  // Wait for the output to land in the history, or there is nothing to scroll into.
  const t0 = Date.now()
  while (parseInt(fmt('#{history_size}'), 10) < 200 && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 50))
  }
})

afterAll(() => {
  if (!tmuxOk) return
  tryTmux(['kill-server'])
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('mouse-copy bindings (tmuxConf), measured', () => {
  it('parses: every copy-mode table has the conditional release for drag, double and triple click', () => {
    if (!tmuxOk) return
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      for (const key of ['MouseDragEnd1Pane', 'DoubleClick1Pane', 'TripleClick1Pane']) {
        const line = bindingLine(table, key)
        expect(line).toContain('#{scroll_position}')
        expect(line).toContain('copy-pipe-and-cancel')
      }
    }
  })

  it('a drag released while SCROLLED UP copies and stays in copy mode at the same position', () => {
    if (!tmuxOk) return
    enterCopyMode(10)
    selectFourChars()
    runBinding('MouseDragEnd1Pane')
    expect(fmt('#{pane_in_mode}')).toBe('1')
    expect(fmt('#{scroll_position}')).toBe('10')
    expect(fmt('#{selection_present}')).toBe('0')
    expect(copied()).not.toBe('SENTINEL')
    expect(copied().length).toBeGreaterThan(0)
  })

  it('a drag released on the LIVE screen copies and leaves copy mode, as before', () => {
    if (!tmuxOk) return
    enterCopyMode(0)
    selectFourChars()
    runBinding('MouseDragEnd1Pane')
    expect(fmt('#{pane_in_mode}')).toBe('0')
    expect(copied()).not.toBe('SENTINEL')
  })

  it('a double click while SCROLLED UP copies the word and stays put', () => {
    if (!tmuxOk) return
    enterCopyMode(10)
    // Copy mode starts on the pane's cursor row, which is the empty line after `seq`'s output.
    // Put the cursor on a number so select-word has a word to take.
    tmux(['send-keys', '-t', SESSION, '-X', '-N', '2', 'cursor-up'])
    tmux(['send-keys', '-t', SESSION, '-X', 'start-of-line'])
    const before = fmt('#{scroll_position}')
    expect(Number(before)).toBeGreaterThan(0)
    runBinding('DoubleClick1Pane')
    expect(fmt('#{pane_in_mode}')).toBe('1')
    expect(fmt('#{scroll_position}')).toBe(before)
    expect(copied()).toMatch(/^\d+$/)
  })
})
