import { describe, expect, it } from 'vitest'
import { defaultWallpaper, GRADIENT_WALLPAPERS, normalizeWallpaper } from './wallpaper'

describe('defaultWallpaper (Liquid Glass chosen with no wallpaper)', () => {
  it('takes the first still (the scan puts Sonoma Horizon first)', () => {
    expect(defaultWallpaper([{ id: 'mac:a' }, { id: 'mac:b' }])).toEqual({ kind: 'preset', id: 'mac:a' })
  })
  it('falls back to a gradient where there are no stills', () => {
    const w = defaultWallpaper([])
    expect(w).toEqual({ kind: 'preset', id: GRADIENT_WALLPAPERS[0].id })
    expect(normalizeWallpaper(w)).toEqual(w)
  })
})
