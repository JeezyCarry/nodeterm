import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { glassRectAlpha, installGlassCellBackgrounds, setGlassCellAlpha } from './glass-cell-backgrounds'
import { relativeLuminance } from '../lib/glassContrast'

const INVERSE = 0x4000000
const CM_P256 = 0x2000000
const CM_RGB = 0x3000000
const DIM = 0x8000000
const ITALIC = 0x4000000
const HAS_EXTENDED = 0x10000000

const BG_LUM = relativeLuminance([30, 30, 30]) // nodeterm-dark background
const FG_LUM = relativeLuminance([212, 212, 212])
const L = (v: number): number => relativeLuminance([v, v, v])

describe('glassRectAlpha', () => {
  const grok = CM_RGB | 0x141414
  it.each([
    ['inverse video / fake cursor', INVERSE, CM_RGB | 0x3a3a3a, CM_RGB | 0x3a3a3a, L(58), 1],
    ['inverse on the default bg', INVERSE, 0, 0, FG_LUM, 1],
    ['DIM on the default bg', 0, DIM, DIM, BG_LUM, 0],
    ['ITALIC on the default bg', 0, ITALIC, ITALIC, BG_LUM, 0],
    ['hyperlink / underline style on the default bg', 0, HAS_EXTENDED, HAS_EXTENDED, BG_LUM, 0],
    ['app panel (truecolor)', 0, grok, grok, L(20), 0.4],
    ['app panel (256-colour, Claude bubble)', 0, CM_P256 | 237, CM_P256 | 237, L(58), 0.4],
    ['dim text on an app panel', 0, grok | DIM, grok | DIM, L(20), 0.4],
    ['selection / block cursor / search highlight (renderer override)', 0, CM_RGB | 0x264f78, grok, relativeLuminance([38, 79, 120]), 1],
    ['override where the buffer cell was unreadable', 0, grok, NaN, L(20), 1],
    ['light panel on a dark theme', 0, CM_RGB | 0xe0e0e0, CM_RGB | 0xe0e0e0, L(224), 1]
  ])('%s', (_name, fg, bg, cellBg, runLum, want) => {
    expect(glassRectAlpha(fg, bg, cellBg, 0.4, 0, runLum, BG_LUM, FG_LUM)).toBe(want)
  })

  it('an attribute-only run takes the theme background alpha, whatever it is', () => {
    expect(glassRectAlpha(0, DIM, DIM, 0.4, 1, BG_LUM, BG_LUM, FG_LUM)).toBe(1)
  })

  it('Reduce Transparency (node alpha 1) leaves app panels opaque', () => {
    expect(glassRectAlpha(0, CM_RGB | 0x141414, CM_RGB | 0x141414, 1, 0, L(20), BG_LUM, FG_LUM)).toBe(1)
  })
})

it('(c·√k, √k) blended SRC_ALPHA over a cleared premultiplied canvas stores exactly (c·k, k)', () => {
  for (const k of [0.2, 0.675, 0.95]) {
    const c = 20 / 255
    const s = Math.sqrt(k)
    expect(c * s * s).toBeCloseTo(c * k, 12) // rgb: src·srcAlpha
    expect(s * s).toBeCloseTo(k, 12) // alpha channel blends the same way
  }
})

it('setGlassCellAlpha reports only real changes', () => {
  const t = {} as Terminal
  expect(setGlassCellAlpha(t, 0.2)).toBe(true)
  expect(setGlassCellAlpha(t, 0.2)).toBe(false)
  expect(setGlassCellAlpha(t, 0.95)).toBe(true)
  expect(setGlassCellAlpha(t, null)).toBe(true)
  expect(setGlassCellAlpha(t, null)).toBe(false)
})

/** A structural fake of the addon's RectangleRenderer, doing what the real `_updateRectangle`
 *  does with the attribute array (colour, then `$a = 1`). One class per test: the wrap patches the
 *  prototype, like it does the real shared one. */
function fakeAddon(cells: Record<number, number>) {
  class RectangleRenderer {
    _themeService = { colors: { background: { rgba: 0x1e1e1e00 }, foreground: { rgba: 0xd4d4d4ff } } }
    _terminal = {
      buffer: {
        active: {
          viewportY: 0,
          getNullCell: () => ({ bg: 0 }),
          getLine: () => ({
            getCell: (x: number, cell: { bg: number }) => {
              cell.bg = cells[x] ?? 0
              return cell
            }
          })
        }
      }
    } as unknown as Terminal
    _updateRectangle(v: { attributes: Float32Array }, offset: number, fg: number, bg: number, _startX: number, _endX: number, _y: number): void {
      const rgba = bg & CM_RGB ? (bg & 0xffffff) << 8 : this._themeService.colors.background.rgba
      v.attributes.set([0, 0, 1, 1, ((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255, ((rgba >>> 8) & 255) / 255, 1], offset)
      void fg
    }
  }
  const rr = new RectangleRenderer()
  const addon = { _renderer: { _rectangleRenderer: { value: rr } } } as unknown as WebglAddon
  const draw = (fg: number, bg: number, x = 0): number[] => {
    const v = { attributes: new Float32Array(8) }
    rr._updateRectangle(v, 0, fg, bg, x, x + 1, 0)
    return Array.from(v.attributes)
  }
  return { addon, rr, draw, proto: RectangleRenderer.prototype }
}

describe('installGlassCellBackgrounds', () => {
  const panel = CM_RGB | 0x141414

  it('glass: an app panel is premultiplied to the node alpha, a dim run vanishes, an override stays', () => {
    const { addon, rr, draw } = fakeAddon({ 0: panel })
    expect(installGlassCellBackgrounds(addon)).toBe(true)
    setGlassCellAlpha(rr._terminal, 0.25)
    const p = draw(0, panel)
    expect(p[7]).toBeCloseTo(0.5, 6) // √0.25
    expect(p[4]).toBeCloseTo((20 / 255) * 0.5, 6)
    expect(draw(0, DIM)[7]).toBe(0)
    expect(draw(0, CM_RGB | 0x264f78)[7]).toBe(1) // rendered bg ≠ buffer bg: selection
    expect(draw(INVERSE, panel)[7]).toBe(1)
  })

  it('non-glass terminals are byte-identical to the stock renderer', () => {
    const stock = fakeAddon({ 0: panel })
    const wrapped = fakeAddon({ 0: panel })
    installGlassCellBackgrounds(wrapped.addon)
    for (const [fg, bg] of [[0, panel], [0, DIM], [INVERSE, panel], [0, CM_RGB | 0x264f78]]) {
      expect(wrapped.draw(fg, bg)).toEqual(stock.draw(fg, bg))
    }
  })

  it('a re-install (hot reload) wraps the original, never the wrap', () => {
    const { addon, rr, draw } = fakeAddon({ 0: panel })
    installGlassCellBackgrounds(addon)
    installGlassCellBackgrounds(addon)
    setGlassCellAlpha(rr._terminal, 0.25)
    expect(draw(0, panel)[7]).toBeCloseTo(0.5, 6) // applied once, not √√
  })

  it('fails open when the internals are missing', () => {
    expect(installGlassCellBackgrounds({} as WebglAddon)).toBe(false)
    expect(installGlassCellBackgrounds({ _renderer: { _rectangleRenderer: { value: {} } } } as unknown as WebglAddon)).toBe(false)
  })
})

/**
 * Guard: the wrap leans on addon-webgl PRIVATES. An upgrade must fail here, loudly, instead of
 * silently falling back to opaque slabs (the wrap fails open). If this fails: re-read
 * `src/RectangleRenderer.ts` of the new version, re-derive the names in glass-cell-backgrounds.ts
 * — or delete the wrap if upstream now honours background alpha.
 */
describe('addon-webgl internals the glass cell wrap relies on', () => {
  const dir = path.resolve(__dirname, '../../../node_modules/@xterm/addon-webgl')
  const bundle = fs.readFileSync(path.join(dir, 'lib/addon-webgl.js'), 'utf8')

  it('is the pinned 0.18.0', () => {
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('0.18.0')
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'))
    expect({ ...pkg.dependencies, ...pkg.devDependencies }['@xterm/addon-webgl']).toBe('0.18.0')
  })

  it.each([
    'this._renderer=', // WebglAddon._renderer
    '_rectangleRenderer.value=new', // WebglRenderer._rectangleRenderer (a MutableDisposable)
    '_updateRectangle(e,t,i,s,r,o,a){', // (vertices, offset, fg, bg, startX, endX, y)
    'updateBackgrounds(',
    'this._terminal=e,this._gl=t,this._dimensions=i,this._themeService', // RectangleRenderer fields
    'e[t+4]=n,e[t+5]=a,e[t+6]=h,e[t+7]=l', // _addRectangle: r,g,b,a at offset+4..7
    'v=1,this._addRectangle(e.attributes,t,' // the forced alpha 1 the wrap rewrites; gone = fixed upstream?
  ])('bundle contains %s', (needle) => {
    expect(bundle).toContain(needle)
  })
})
