// User-owned JSON is never repaired by an installer. Only ENOENT means a new config.
import { lstatSync, readFileSync, mkdirSync, rmdirSync, statSync, writeFileSync, rmSync, chmodSync, realpathSync } from 'fs'
import path from 'path'
import { renameAtomicSync, tempNameFor } from '../../fs-atomic'

export function parseSettings(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object')
  return value as Record<string, unknown>
}

function snapshot(file: string): string | null {
  try {
    // Do not replace links (including dangling links), devices, or directories.
    if (!lstatSync(file).isFile()) throw new Error('Settings must be a regular file')
    return readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

function settingsTarget(file: string): string {
  try {
    return realpathSync(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    // A missing file is creatable; a dangling symlink is not ours to repair.
    try { if (lstatSync(file).isSymbolicLink()) throw new Error('Dangling settings link') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return path.join(realpathSync(path.dirname(file)), path.basename(file))
  }
}

/** Serialize our writers, stage before publishing, and refuse stale snapshots. Other programs
 * do not honor our lock: the final comparison narrows, but cannot eliminate, their rename race. */
export function updateSettingsFile(requested: string, update: (config: Record<string, unknown>) => Record<string, unknown>): boolean {
  let lock = ''
  let locked = false
  let tmp: string | undefined
  try {
    mkdirSync(path.dirname(requested), { recursive: true })
    const file = settingsTarget(requested)
    lock = `${file}.nodeterm-lock`
    mkdirSync(lock)
    locked = true
    const before = snapshot(file)
    const config = before === null ? {} : parseSettings(before)
    const original = JSON.stringify(config)
    const updated = update(config)
    if (before !== null && JSON.stringify(updated) === original) return false
    const next = JSON.stringify(updated, null, 2)
    tmp = tempNameFor(file)
    const mode = before === null ? 0o600 : statSync(file).mode & 0o777
    writeFileSync(tmp, next, { flag: 'wx', mode })
    chmodSync(tmp, mode)
    if (settingsTarget(requested) !== file || snapshot(file) !== before) return false
    renameAtomicSync(tmp, file)
    return true
  } catch {
    return false // fail open for the session, fail closed for the user's settings
  } finally {
    try { if (tmp) rmSync(tmp, { force: true }) } catch { /* best-effort cleanup */ }
    try { if (locked) rmdirSync(lock) } catch { /* never break session startup */ }
  }
}
