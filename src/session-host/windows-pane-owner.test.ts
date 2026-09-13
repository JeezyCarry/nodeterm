import { describe, expect, it } from 'vitest'
import { isAgentPane } from '../shared/agents/pane-owner-predicate'
import { windowsConsoleOwner, windowsConsoleProbeScript, type WindowsConsoleProcess } from './windows-pane-owner'

const root: WindowsConsoleProcess = { pid: 10, parent: 1, executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', born: '2026-09-12T10:00:00Z' }
const agent: WindowsConsoleProcess = { pid: 20, parent: 10, executable: 'C:\\Users\\A User\\bin\\opencode.exe', born: '2026-09-12T10:00:01Z' }
const owner = (processes = [root, agent], console = [10, 20]) => windowsConsoleOwner(10, 'generation-a', { processes, console })

describe('Windows console agent identity', () => {
  it('identifies a native executable with spaces in its path, keeping process birth and generation', () => {
    const result = owner()
    expect(isAgentPane(result, 'opencode')).toBe('agent')
    expect(result).toMatchObject({ panePid: 10, pids: [20], processBirths: [agent.born] })
    expect(result?.paneId).toContain('generation-a')
  })
  it('does not mistake a returned PowerShell prompt for an agent', () => {
    expect(isAgentPane(owner([root], [10]), 'opencode')).toBe('not-agent')
  })
  it('rejects a detached agent and an ambiguous shell with two children', () => {
    expect(owner([root, agent], [10])).toBeNull()
    expect(owner([root, agent, { ...agent, pid: 30 }], [10, 20, 30])).toBeNull()
  })
  it('does not choose an MCP descendant or match an executable by substring', () => {
    const worker = { ...agent, pid: 30, parent: 20, executable: 'C:\\bin\\python.exe' }
    expect(owner([root, agent, worker], [10, 20, 30])?.pids).toEqual([20])
    expect(isAgentPane(owner([root, { ...agent, executable: 'C:\\bin\\not-opencode.exe' }]), 'opencode')).toBe('not-agent')
  })
  it('rejects incomplete identity and a recycled parent PID', () => {
    expect(owner([{ ...root, born: '' }, agent])).toBeNull()
    expect(owner([root, { ...agent, born: '2025-01-01T00:00:00Z' }])).toBeNull()
  })
  it('never interpolates a non-integer process identifier into PowerShell', () => {
    expect(() => windowsConsoleProbeScript(NaN)).toThrow()
    expect(() => windowsConsoleProbeScript(-1)).toThrow()
  })
})
