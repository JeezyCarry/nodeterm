import { useEffect, useState } from 'react'
import { gradientCss, normalizeWallpaper, type DesktopWallpaper } from '@shared/wallpaper'
import { useSettings } from './settings'

/**
 * The canvas background for the current `desktopWallpaper` setting, as a CSS `background` value,
 * or null for none (the canvas then draws exactly as before).
 *
 * A gradient preset is CSS and resolves synchronously. A still or an imported image is a data:
 * URL from core (`wallpaper.load`), cached here by value so a re-render or a round trip through
 * Settings never re-reads a multi-MB file. A load that fails resolves to null — degrade to the
 * plain canvas, never to a stale picture.
 */
const loaded = new Map<string, Promise<string | null>>()

function cacheKey(w: DesktopWallpaper): string {
  return JSON.stringify(w)
}

function load(w: DesktopWallpaper): Promise<string | null> {
  const key = cacheKey(w)
  let p = loaded.get(key)
  if (!p) {
    // ponytail: keep only the latest image; a picker session that flips through ten stills would
    // otherwise pin ten data: URLs in memory for the app run.
    loaded.clear()
    p = window.nodeTerminal.wallpaper
      .load(w)
      .then((url) => (url ? `center / cover no-repeat url("${url}")` : null))
      .catch(() => null)
    loaded.set(key, p)
  }
  return p
}

export function useWallpaperBackground(): string | null {
  const raw = useSettings((s) => s.settings.desktopWallpaper)
  const w = normalizeWallpaper(raw)
  const key = cacheKey(w)
  // null = no wallpaper, a string = a gradient, undefined = a file that has to be loaded.
  const sync = w.kind === 'none' ? null : w.kind === 'preset' ? gradientCss(w.id) : undefined
  const [async, setAsync] = useState<{ key: string; bg: string | null } | null>(null)
  useEffect(() => {
    if (sync !== undefined) return
    let live = true
    void load(w).then((bg) => {
      if (live) setAsync({ key, bg })
    })
    return () => {
      live = false
    }
    // `key` carries `w`'s identity; `w` itself is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sync])
  if (sync !== undefined) return sync
  return async?.key === key ? async.bg : null
}
