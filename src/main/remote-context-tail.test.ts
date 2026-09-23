import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRemoteContextTail } from './remote-context-tail'
import { RemoteFile, type RemoteFileRef } from './remote-ssh/remote-file'

const cap = 1024 * 1024
const ref: RemoteFileRef = { conn: { host: 'fixture', user: 'fixture' }, controlPath: '/unused', path: '/fixture' }
const usage = (used: number): string => JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: used } } }) + '\n'
const notification = (result: string): string => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><tool-use-id>tu</tool-use-id><status>completed</status><result>${result}</result></task-notification>` }) + '\n'
const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu', content: 'done' }] } }) + '\n'
function harness(remote: Pick<RemoteFile, 'readContextWindow'>) {
  const send = vi.fn(), onTaskNotification = vi.fn(), onToolResult = vi.fn()
  const tail = createRemoteContextTail({ isDestroyed: () => false, webContents: { send } } as never, remote as RemoteFile, { onTaskNotification, onToolResult })
  return { tail, send, onTaskNotification, onToolResult }
}
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0) }

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('remote context polling', () => {
  it('backs off failures to 60s, logs no remote error content, and recovers at the same offset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const readContextWindow = vi.fn().mockRejectedValue(new Error('SECRET transcript'))
    const h = harness({ readContextWindow })
    h.tail.track('s', ref)
    await flush()
    for (const delay of [2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      const calls = readContextWindow.mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1000)
      expect(readContextWindow).toHaveBeenCalledTimes(calls)
      await vi.advanceTimersByTimeAsync(1000)
      expect(readContextWindow).toHaveBeenCalledTimes(calls + 1)
    }
    expect(warn.mock.calls.flat().join()).not.toContain('SECRET')
    readContextWindow.mockResolvedValue({ data: Buffer.from(usage(120)), start: 0, newOffset: 200, initial: true })
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(120)
    await vi.advanceTimersByTimeAsync(1000)
    expect(readContextWindow).toHaveBeenLastCalledWith(ref, 200, cap)
    h.tail.untrack('s')
  })

  it('serializes reads and ignores detached or replaced in-flight snapshots', async () => {
    let finish!: (value: unknown) => void
    const readContextWindow = vi.fn(() => new Promise(resolve => { finish = resolve }))
    const h = harness({ readContextWindow } as never)
    h.tail.track('s', ref)
    const oldFinish = finish
    await vi.advanceTimersByTimeAsync(3000)
    expect(readContextWindow).toHaveBeenCalledTimes(1)
    h.tail.track('s', { ...ref, controlPath: '/new-owner' })
    oldFinish({ data: Buffer.from(usage(100)), newOffset: 100, initial: true })
    await flush()
    expect(h.send).not.toHaveBeenCalled()
    h.tail.untrack('s')
    finish({ data: Buffer.from(usage(200)), newOffset: 200, initial: true })
    await flush()
    expect(h.send).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')('real POSIX shell transcript fixture (no SSH/session access)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nt-transcript-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  function fixture(initial: string | Buffer) {
    const path = join(dir, "transcript ' fixture.jsonl")
    writeFileSync(path, initial)
    const transfers: number[] = []
    const reader = new RemoteFile(async args => {
      const stdout = execFileSync('/bin/sh', ['-c', args.at(-1)!], { encoding: 'utf8', maxBuffer: 2 * cap })
      transfers.push(Buffer.byteLength(stdout))
      return { code: 0, stdout }
    })
    const read = vi.spyOn(reader, 'readContextWindow')
    const h = harness(reader)
    h.tail.track('s', { ...ref, path })
    return { ...h, path, transfers, read }
  }

  it('bounds transfer for an idle >20 MiB file, starts at EOF, and never replays historical events', async () => {
    const history = notification('historical') + tool + usage(100)
    const content = Buffer.concat([Buffer.alloc(20 * cap, 10), Buffer.from(history)])
    const h = fixture(content)
    await flush()
    await expect(h.read.mock.results[0].value).resolves.toHaveProperty('newOffset', content.length)
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(100)
    expect(h.transfers[0]).toBeLessThan(1.6 * cap)
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.read.mock.calls.slice(1).every(c => c[1] === content.length)).toBe(true)
    expect(h.transfers.slice(1).every(n => n < 100)).toBe(true)
    expect(h.onTaskNotification).not.toHaveBeenCalled()
    expect(h.onToolResult).not.toHaveBeenCalled()
    expect(h.send).toHaveBeenCalledTimes(1)

    // Position the cap in the middle of a UTF-8 character inside a new notification.
    const event = Buffer.from(notification('yeni é 🐈'))
    const split = event.indexOf(Buffer.from('é')) + 1
    appendFileSync(h.path, Buffer.concat([Buffer.alloc(cap - split, 10), event, Buffer.from(tool + usage(200)), Buffer.alloc(18 * cap, 10)]))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification).toHaveBeenCalledExactlyOnceWith('s', expect.objectContaining({ result: 'yeni é 🐈' }))
    expect(h.onToolResult).toHaveBeenCalledExactlyOnceWith('s')
    expect(h.send.mock.calls.at(-1)?.[1].usedTokens).toBe(200)
    expect(h.transfers.every(n => n < 1.6 * cap)).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.onTaskNotification).toHaveBeenCalledTimes(1)
    h.tail.untrack('s')
  })

  it('suppresses historical torn lines, resets after truncation, and handles an initially empty file', async () => {
    const h = fixture('')
    await flush()
    appendFileSync(h.path, notification('fresh') + usage(10))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification).toHaveBeenCalledTimes(1)
    const torn = notification('old').trimEnd()
    writeFileSync(h.path, torn.slice(0, -5))
    await vi.advanceTimersByTimeAsync(1000)
    appendFileSync(h.path, torn.slice(-5) + '\n' + notification('next'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.onTaskNotification.mock.calls.map(c => c[1].result)).toEqual(['fresh', 'next'])
    h.tail.untrack('s')
  })
})
