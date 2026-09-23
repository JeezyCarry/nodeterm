import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLaunchWriter, deliverInitialLaunch, launchCommand, registerLaunchWriter } from './launch-command'
import { KILL_LINE, WINDOWS_KILL_LINE, VERIFY_TIMEOUT_MS, DELIVERY_ATTEMPTS } from './command-delivery'

function fixture(fresh = true, killLine = KILL_LINE) {
  const cleanups: Array<() => void> = []
  let output: ((text: string) => void) | undefined
  const write = vi.fn()
  const shellReady = vi.fn(async () => true)
  const writer = createLaunchWriter({ fresh, io: {
    write, onData: (cb) => { output = cb; return () => { output = undefined } }
  }, shellReady, killLine, cleanup: (cancel) => cleanups.push(cancel) })
  return { writer, write, shellReady, echo: (text: string) => output?.(text),
    dispose: () => cleanups.forEach((fn) => fn()) }
}
afterEach(() => vi.useRealTimers())
describe('durable launch delivery', () => {
  it('acknowledges only after echoed command and Enter; stale UI and concurrent clicks never paste twice', async () => {
    const f = fixture()
    const command = 'claude complete-brief'
    const first = f.writer(command, false)
    expect(f.writer(command, true)).toBe(first)
    await Promise.resolve()
    expect(f.write.mock.calls).toEqual([[command]])
    f.echo(command)
    expect(await first).toBe('submitted')
    expect(await f.writer(command, true)).toBe('submitted')
    expect(f.write.mock.calls).toEqual([[command], ['\r']])
  })
  it('repairs a swallowed head using Ctrl-U before submitting', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const command = 'claude complete-brief'
    const result = f.writer(command, false)
    await Promise.resolve()
    f.echo('complete-brief')
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS)
    expect(f.write.mock.calls).toEqual([[command], [KILL_LINE], [command]])
    f.echo(command)
    expect(await result).toBe('submitted')
  })
  it('retains overlong unverified launches and refuses automatic reattempts, but permits an explicit retry', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const command = 'x'.repeat(2000)
    const result = f.writer(command, false)
    await vi.advanceTimersByTimeAsync(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    expect(await result).toBe('line-too-long')
    expect(f.write).not.toHaveBeenCalledWith('\r')
    const calls = f.write.mock.calls.length
    expect(await f.writer(command, false)).toBe('cancelled')
    expect(f.write).toHaveBeenCalledTimes(calls)
    const retry = f.writer(command, true)
    await Promise.resolve()
    f.echo(command)
    expect(await retry).toBe('submitted')
  })
  it('does not replay a durable command on warm resume even if its successful clear was never saved', async () => {
    const f = fixture(false)
    expect(await f.writer('codex brief', false)).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
    f.shellReady.mockResolvedValue(false) // running agent/editor: manual retry also refuses
    expect(await f.writer('codex brief', true)).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
    f.shellReady.mockResolvedValue(true)
    const retry = f.writer('codex brief', true)
    await Promise.resolve()
    f.echo('codex brief')
    expect(await retry).toBe('submitted')
  })
  it('manual Windows recovery clears a partial line with Escape and submits Enter separately after echo', async () => {
    const f = fixture(false, WINDOWS_KILL_LINE)
    const result = f.writer('codex brief', true)
    await Promise.resolve()
    expect(f.write.mock.calls).toEqual([[WINDOWS_KILL_LINE], ['codex brief']])
    f.echo('codex brief')
    expect(await result).toBe('submitted')
    expect(f.write.mock.calls).toEqual([[WINDOWS_KILL_LINE], ['codex brief'], ['\r']])
    expect(f.write).not.toHaveBeenCalledWith(KILL_LINE)
  })
  it('cancels teardown during shell probing without losing the command or writing late', async () => {
    const f = fixture()
    let ready!: (value: boolean) => void
    f.shellReady.mockImplementation(() => new Promise((resolve) => { ready = resolve }))
    const result = f.writer('codex brief', false)
    f.dispose()
    ready(true)
    expect(await result).toBe('cancelled')
    expect(f.write).not.toHaveBeenCalled()
  })
  it('cancels teardown during echo verification without Enter or an orphan retry timer', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const result = f.writer('codex brief', false)
    await Promise.resolve()
    f.dispose()
    expect(await result).toBe('cancelled')
    await vi.runAllTimersAsync()
    expect(f.write.mock.calls).toEqual([['codex brief']])
  })
  it.each(['probe', 'command', 'enter'])('reports a rejected %s as unconfirmed and allows manual recovery', async (failure) => {
    const f = fixture()
    if (failure === 'probe') f.shellReady.mockRejectedValueOnce(new Error('offline'))
    else f.write.mockImplementation((text) => {
      if (failure === 'command' || text === '\r') throw new Error('offline')
    })
    const result = f.writer('claude brief', false)
    await Promise.resolve()
    f.echo('claude brief')
    expect(await result).toBe('cancelled')
    f.write.mockReset()
    const retry = f.writer('claude brief', true)
    await Promise.resolve()
    f.echo('claude brief')
    expect(await retry).toBe('submitted')
  })
  it('an unmounted writer cannot be reached, and an old cleanup cannot remove its replacement', async () => {
    const first = registerLaunchWriter('node', async () => 'cancelled')
    const second = registerLaunchWriter('node', async () => 'submitted')
    first()
    expect(await launchCommand('node', 'cmd')).toBe('submitted')
    second()
    expect(await launchCommand('node', 'cmd', true)).toBe('cancelled')
  })
})

describe('UI initial-command lifecycle', () => {
  it.each(['submitted', 'cancelled', 'line-too-long'] as const)('retains intent through settle and only discards it on submitted (%s)', async (outcome) => {
    let ready!: () => void
    let settle!: (outcome: 'submitted' | 'cancelled' | 'line-too-long') => void
    const state: { initialCommand?: string; pendingLaunch?: { command: string } } = { initialCommand: 'claude original-brief' }
    const write = vi.fn(() => new Promise<'submitted' | 'cancelled' | 'line-too-long'>((resolve) => { settle = resolve }))
    const onFailure = vi.fn()
    deliverInitialLaunch(state.initialCommand!, {
      whenReady: (run) => { ready = run }, write,
      update: (patch) => { Object.assign(state, patch) }, onFailure
    })
    // Teardown/park before ready cannot lose the brief: both live and durable intent remain.
    expect(write).not.toHaveBeenCalled()
    expect(state.initialCommand).toBe('claude original-brief')
    expect(state.pendingLaunch).toEqual({ after: [], command: 'claude original-brief', manualOnly: true })
    ready()
    expect(write).toHaveBeenCalledWith('claude original-brief', false)
    expect(state.initialCommand).toBe('claude original-brief')
    settle(outcome)
    await Promise.resolve()
    expect(state.initialCommand).toBeUndefined()
    if (outcome === 'submitted') {
      expect(state.pendingLaunch).toBeUndefined()
      expect(onFailure).not.toHaveBeenCalled()
    } else {
      expect(state.pendingLaunch?.command).toBe('claude original-brief')
      expect(onFailure).toHaveBeenCalledWith(outcome)
    }
  })
})
