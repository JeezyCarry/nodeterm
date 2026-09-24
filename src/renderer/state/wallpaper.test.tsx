// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from './settings'
import { useBoardWallpaperStyle } from './wallpaper'

// A board opens long after the canvas loaded the wallpaper; its first frame must already carry the
// picture, or the board flashes its plain background (black) for a frame on every open.
function Probe({ seen }: { seen: (string | undefined)[] }) {
  seen.push(useBoardWallpaperStyle()?.backgroundImage as string | undefined)
  return null
}

describe('useBoardWallpaperStyle', () => {
  const roots: Root[] = []
  const mount = (seen: (string | undefined)[]): void => {
    const root = createRoot(document.createElement('div'))
    roots.push(root)
    act(() => root.render(<Probe seen={seen} />))
  }
  afterEach(() => {
    act(() => roots.splice(0).forEach((r) => r.unmount()))
    vi.unstubAllGlobals()
  })

  it('a hook mounting after the load paints the wallpaper on its first frame', async () => {
    const load = vi.fn(async () => 'data:image/jpeg;base64,AAAA')
    vi.stubGlobal('nodeTerminal', { wallpaper: { load } })
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, appTheme: 'liquid-glass', desktopWallpaper: { kind: 'image', path: 'a.jpg' } }
    })
    const canvas: (string | undefined)[] = []
    mount(canvas) // the canvas: first mount, has to wait for the load
    await act(async () => {})
    expect(canvas.at(-1)).toBe('url("data:image/jpeg;base64,AAAA")')

    const board: (string | undefined)[] = []
    mount(board) // the board, opened later
    expect(board[0]).toBe('url("data:image/jpeg;base64,AAAA")')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
