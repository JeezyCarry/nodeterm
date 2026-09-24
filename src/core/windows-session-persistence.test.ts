import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manager = readFileSync(join(__dirname, 'pty-manager.ts'), 'utf8')
const terminal = readFileSync(join(__dirname, '..', 'renderer', 'nodes', 'TerminalNode.tsx'), 'utf8')

describe('Windows persistent-session integration', () => {
  it('always routes Windows sessions to the packaged session host', () => {
    expect(manager).toMatch(
      /if \(os\.platform\(\) === 'win32'\) \{[\s\S]{0,500}?return null\s*\}/
    )
    expect(manager).toContain("sessionHostSupported() ? 'session-host' : null")
  })

  it('preserves the inherited Windows Path when prepending the Codex launcher', () => {
    expect(manager).toContain("env.PATH ?? env.Path ?? ''")
  })

  it('delivers a fresh launch without probing a session-host pane first', () => {
    expect(terminal).toContain(
      '(!manual && fresh) || isLaunchShell(await queryPaneWithin(() => api.pty.paneCommand(id), RESTART_EXIT_TIMEOUT_MS))'
    )
    expect(terminal).not.toContain('fresh && !sessionPersistent) || isLaunchShell(')
  })
})
