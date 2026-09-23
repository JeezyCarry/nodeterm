import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../shared/ipc'
import {
  normalizeWallpaper,
  type DesktopWallpaper,
  type WallpaperStill
} from '../shared/wallpaper'
import { renameAtomic, tempNameFor } from './fs-atomic'
import { platform } from './platform'

/**
 * Wallpaper files for the canvas background (Liquid Glass appearance). Core, so both shells serve
 * it: on the Server Edition (Linux) the stills list is simply empty and gradients need no files.
 *
 * Every file the renderer can get bytes for lives in ONE directory, `<userData>/wallpapers/`, under
 * a hash name this module minted. The renderer never names a path to read: a still is named by its
 * `mac:` id and re-resolved against a fresh scan, and an imported image's path must be a direct
 * child of the cache dir with a hash-shaped name (`cachedImagePath`). So a hand-edited
 * settings.json cannot aim `load` at anything else, and there is no traversal to reject because
 * no caller-supplied segment is ever joined.
 */

const run = promisify(execFile)

export const SYSTEM_WALLPAPER_DIR = '/System/Library/Desktop Pictures'
const SIPS = '/usr/bin/sips'
/** Real stills are several MB; the 356px `.madesktop` placeholders and thumbnails are not. */
const MIN_STILL_BYTES = 1_000_000
const STILL_EXT = /\.(heic|jpe?g|png)$/i
const IMPORT_EXT = /\.(heic|jpe?g|png|webp)$/i
/** Shown first, in this order: the scenic ones. */
const SCENIC_FIRST = ['Sonoma Horizon', 'Sonoma']
const FULL_PX = 3840
const THUMB_PX = 320
/** Refuse to ship anything bigger over IPC as a data: URL. */
const MAX_LOAD_BYTES = 25 * 1024 * 1024
const CACHED_NAME = /^[0-9a-f]{40}(-t)?\.(jpg|jpeg|png|webp)$/

export interface ScannedStill {
  id: string
  label: string
  path: string
}

export function wallpaperCacheDir(): string {
  return path.join(platform().userDataDir, 'wallpapers')
}

/**
 * The stock macOS stills under `root`, scenic first. Recurses into `.wallpapers/<name>/`, skips
 * `.thumbnails` and anything under 1 MB (which is what drops the `.madesktop` placeholders' tiny
 * siblings). A missing root is an empty list, which is the answer everywhere but macOS.
 */
export async function scanStills(root = SYSTEM_WALLPAPER_DIR, depth = 3): Promise<ScannedStill[]> {
  const found: ScannedStill[] = []
  const walk = async (dir: string, left: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name !== '.thumbnails' && left > 0) await walk(p, left - 1)
      } else if (e.isFile() && STILL_EXT.test(e.name)) {
        try {
          if ((await stat(p)).size < MIN_STILL_BYTES) continue
        } catch {
          continue
        }
        const rel = path.relative(root, p).split(path.sep).join('/')
        found.push({ id: `mac:${rel}`, label: e.name.replace(STILL_EXT, ''), path: p })
      }
    }
  }
  await walk(root, depth)
  const seen = new Set<string>()
  const rank = (label: string): number => {
    const i = SCENIC_FIRST.indexOf(label)
    return i === -1 ? SCENIC_FIRST.length : i
  }
  return found
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label))
    .filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)))
}

/** A cached file's name: stable per source file version and output size. */
async function cacheKey(src: string, variant: string): Promise<string> {
  const st = await stat(src)
  return createHash('sha1').update(`${src}\x00${st.mtimeMs}\x00${st.size}\x00${variant}`).digest('hex')
}

/** In-flight conversions, so two callers asking for the same file share one `sips`. */
const inflight = new Map<string, Promise<string>>()

/** Publish `produce(tmp)` at `target` through a unique temp, unless it is already there. */
function publishOnce(target: string, produce: (tmp: string) => Promise<void>): Promise<string> {
  const pending = inflight.get(target)
  if (pending) return pending
  const job = (async () => {
    try {
      await stat(target)
      return target
    } catch {
      // not cached yet
    }
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = tempNameFor(target)
    try {
      await produce(tmp)
      await renameAtomic(tmp, target)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
    return target
  })().finally(() => inflight.delete(target))
  inflight.set(target, job)
  return job
}

/** HEIC/JPEG/PNG → JPEG no larger than `px` on its long edge, via macOS's built-in `sips`. */
async function convertWithSips(src: string, px: number, suffix: string): Promise<string> {
  const target = path.join(wallpaperCacheDir(), `${await cacheKey(src, `sips${px}`)}${suffix}.jpg`)
  return publishOnce(target, async (tmp) => {
    await run(SIPS, ['-s', 'format', 'jpeg', '-Z', String(px), src, '--out', tmp], {
      timeout: 60_000
    })
  })
}

let stillScan: Promise<ScannedStill[]> | null = null
function stills(): Promise<ScannedStill[]> {
  if (process.platform !== 'darwin') return Promise.resolve([])
  // One scan per app run: the system stills only change with an OS update.
  stillScan ??= scanStills().catch(() => [])
  return stillScan
}

async function toDataUrl(file: string): Promise<string | null> {
  try {
    const st = await stat(file)
    if (st.size > MAX_LOAD_BYTES) return null
    const ext = path.extname(file).slice(1).toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${(await readFile(file)).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * The cache file an `image` wallpaper names, or null when the value names anything else. Only a
 * DIRECT child of the cache dir with a hash-shaped name qualifies — that is the whole jail.
 */
export function cachedImagePath(p: string, cacheDir = wallpaperCacheDir()): string | null {
  if (typeof p !== 'string' || p.length === 0) return null
  const resolved = path.resolve(p)
  if (path.dirname(resolved) !== path.resolve(cacheDir)) return null
  if (!CACHED_NAME.test(path.basename(resolved))) return null
  return resolved
}

export async function listStills(): Promise<WallpaperStill[]> {
  const list = await stills()
  const out: WallpaperStill[] = []
  // Sequential on purpose: a fresh cache runs one `sips` per still, and a dozen at once is a burst
  // of CPU for a grid of 320px thumbnails. Cached, each is a stat plus a small read.
  for (const s of list) {
    const thumb = await convertWithSips(s.path, THUMB_PX, '-t')
      .then(toDataUrl)
      .catch(() => null)
    out.push({ id: s.id, label: s.label, thumb })
  }
  return out
}

export async function loadWallpaper(value: unknown): Promise<string | null> {
  const w = normalizeWallpaper(value)
  if (w.kind === 'image') {
    const file = cachedImagePath(w.path)
    return file ? toDataUrl(file) : null
  }
  if (w.kind === 'preset' && w.id.startsWith('mac:')) {
    const still = (await stills()).find((s) => s.id === w.id)
    if (!still) return null
    return convertWithSips(still.path, FULL_PX, '')
      .then(toDataUrl)
      .catch(() => null)
  }
  return null
}

/**
 * Copy a picked image into the cache (HEIC is converted, since Chromium cannot decode it) and
 * return the value to store. The copy is what keeps the wallpaper when the original moves.
 */
export async function importWallpaper(sourcePath: unknown): Promise<DesktopWallpaper> {
  if (typeof sourcePath !== 'string' || !IMPORT_EXT.test(sourcePath)) {
    throw new Error('Choose a JPEG, PNG, WebP or HEIC image.')
  }
  const src = path.resolve(sourcePath)
  if (/\.heic$/i.test(src)) {
    if (process.platform !== 'darwin') throw new Error('HEIC images can only be converted on macOS.')
    return { kind: 'image', path: await convertWithSips(src, FULL_PX, '') }
  }
  const ext = path.extname(src).toLowerCase().replace('.jpeg', '.jpg')
  const target = path.join(wallpaperCacheDir(), `${await cacheKey(src, 'copy')}${ext}`)
  await publishOnce(target, (tmp) => copyFile(src, tmp))
  return { kind: 'image', path: target }
}

/** Wire onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerWallpaperIpc(): void {
  platform().handle(IPC.wallpaperListStills, () => listStills())
  platform().handle(IPC.wallpaperLoad, (value: unknown) => loadWallpaper(value))
  platform().handle(IPC.wallpaperImport, (sourcePath: unknown) => importWallpaper(sourcePath))
}
