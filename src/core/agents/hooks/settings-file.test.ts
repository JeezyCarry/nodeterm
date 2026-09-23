import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, lstatSync, chmodSync, statSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { updateSettingsFile } from './settings-file'
import { updateRemoteSettingsFile, type SettingsRunner } from './remote-settings-file'
import { mergeManagedHook } from './install-helper'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nt-settings-ö '"))
  file = path.join(dir, 'settings.json')
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })
const shell: SettingsRunner = async (command, stdin) => {
  const result = spawnSync('/bin/sh', ['-c', command], { input: stdin, encoding: 'utf8' })
  if (result.error) throw result.error
  return { code: result.status ?? 1, stdout: result.stdout }
}
const merge = (config: Record<string, unknown>) => mergeManagedHook(config, "sh '/home/u/.nodeterm/agent-hooks/claude.sh'", ['Stop'])

for (const remote of [false, true]) {
  describe(remote ? 'remote settings shell transaction' : 'local settings transaction', () => {
    const update = (transform = merge) => remote
      ? updateRemoteSettingsFile(file, shell, transform)
      : Promise.resolve(updateSettingsFile(file, transform))

    it('creates a missing file and preserves settings, foreign handlers and mode on reinstall', async () => {
      expect(await update()).toBe(true)
      const foreign = { type: 'command', command: 'notify-me' }
      const original = { outputStyle: 'caveman', model: 'opus[1m]', statusLine: { command: 'mine' }, hooks: {
        Stop: [{ matcher: '*', hooks: [foreign, { type: 'command', command: "sh '/old/agent-hooks/claude.sh'" }] }]
      } }
      writeFileSync(file, JSON.stringify(original))
      chmodSync(file, 0o640)
      expect(await update()).toBe(true)
      const result = JSON.parse(readFileSync(file, 'utf8'))
      expect(result).toMatchObject({ outputStyle: original.outputStyle, model: original.model, statusLine: original.statusLine })
      expect(result.hooks.Stop[0]).toEqual({ matcher: '*', hooks: [foreign] })
      const once = readFileSync(file, 'utf8')
      expect(await update()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(once)
      expect(statSync(file).mode & 0o777).toBe(0o640)
    })

    it.each(['', '{broken', 'null', '[]', '42', '{"hooks":null}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[null]}}', '{"hooks":{"Stop":[{"hooks":[null]}]}}'])('preserves malformed settings: %s', async (raw) => {
      writeFileSync(file, raw)
      expect(await update()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(raw)
    })

    it('does not replace a directory/read error with settings', async () => {
      mkdirSync(file)
      expect(await update()).toBe(false)
      expect(lstatSync(file).isDirectory()).toBe(true)
    })

    it('preserves symlinks and unrelated target settings', async () => {
      const target = path.join(dir, 'target')
      writeFileSync(target, '{"model":"keep"}')
      symlinkSync(target, file)
      expect(await update()).toBe(!remote)
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
      expect(JSON.parse(readFileSync(target, 'utf8')).model).toBe('keep')
    })

    it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for a writer', async () => {
      const fifo = spawnSync('mkfifo', [file])
      expect(fifo.status).toBe(0)
      expect(await update()).toBe(false)
      expect(lstatSync(file).isFIFO()).toBe(true)
    })

    it('leaves dangling symlinks untouched', async () => {
      symlinkSync(path.join(dir, 'absent'), file)
      expect(await update()).toBe(false)
      expect(lstatSync(file).isSymbolicLink()).toBe(true)
    })

    it('does not take over another nodeterm writer lock', async () => {
      writeFileSync(file, '{}')
      mkdirSync(`${file}.nodeterm-lock`)
      expect(await update()).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe('{}')
      expect(lstatSync(`${file}.nodeterm-lock`).isDirectory()).toBe(true)
    })

    it.each([false, true])('refuses stale snapshots including concurrent creation (missing=%s)', async (missing) => {
      if (!missing) writeFileSync(file, '{}')
      const newer = '{"model":"newer", "hooks":{"Stop":[{"hooks":[{"command":"keep-me"}]}]}}'
      expect(await update((config) => { writeFileSync(file, newer); return merge(config) })).toBe(false)
      expect(readFileSync(file, 'utf8')).toBe(newer)
    })
  })
}

it('remote read failure is not absence, even with valid partial stdout', async () => {
  const run = vi.fn(async () => ({ code: 1, stdout: '{}' }))
  expect(await updateRemoteSettingsFile(file, run, merge)).toBe(false)
  expect(run).toHaveBeenCalledTimes(1)
})

it('remote staged input truncation cannot publish a partial document', async () => {
  writeFileSync(file, '{}')
  const run: SettingsRunner = (cmd, input) => shell(cmd, input === undefined ? undefined : input.slice(0, -8))
  expect(await updateRemoteSettingsFile(file, run, merge)).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('{}')
})
