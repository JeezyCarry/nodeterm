import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TERMINAL_THEMES } from '../terminal/themes'
import {
  GLASS_ALPHA_MAX,
  GLASS_ALPHA_MIN,
  composite,
  contrastRatio,
  glassTintAlpha,
  chromeContrast,
  glassChromeAlpha,
  parseCssColor,
  parseHex,
  worstContrast
} from './glassContrast'

const WHITE = [255, 255, 255] as const
const BLACK = [0, 0, 0] as const

describe('glassTintAlpha', () => {
  it('hand-checked: #d4d4d4 text on a black tint needs about 0.64', () => {
    // Over white, the composite grey is (1-a)·255; contrast with #d4d4d4 (L≈0.658) reaches 4.5 when
    // the grey's luminance drops to ≈0.107, i.e. an sRGB value of ≈0.361 → a ≈ 0.639.
    const a = glassTintAlpha('#d4d4d4', '#000000')
    expect(a).toBeGreaterThan(0.63)
    expect(a).toBeLessThan(0.65)
  })

  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s keeps 4.5:1 (or its own opaque contrast, if lower) over a white AND a black backdrop',
    (_id, t) => {
      const fg = parseHex(t.theme.foreground!)!
      const tint = parseHex(t.theme.background!)!
      const a = glassTintAlpha(t.theme.foreground!, t.theme.background!)
      const floor = Math.min(4.5, contrastRatio(fg, tint))
      expect(a).toBeGreaterThanOrEqual(GLASS_ALPHA_MIN)
      expect(a).toBeLessThanOrEqual(1)
      expect(contrastRatio(fg, composite(tint, WHITE, a))).toBeGreaterThanOrEqual(floor)
      expect(contrastRatio(fg, composite(tint, BLACK, a))).toBeGreaterThanOrEqual(floor)
    }
  )

  it('only the Solarized themes exceed the 0.95 design ceiling, and only Solarized Light is opaque', () => {
    const over = TERMINAL_THEMES.filter(
      (t) => glassTintAlpha(t.theme.foreground!, t.theme.background!) > GLASS_ALPHA_MAX
    ).map((t) => t.id)
    expect(over.sort()).toEqual(['solarized-dark', 'solarized-light'])
    const light = TERMINAL_THEMES.find((t) => t.id === 'solarized-light')!
    // 4.13:1 opaque — no translucent tint can reach 4.5, so glass must not make it any worse.
    expect(contrastRatio(parseHex(light.theme.foreground!)!, parseHex(light.theme.background!)!)).toBeLessThan(4.5)
    expect(glassTintAlpha(light.theme.foreground!, light.theme.background!)).toBe(1)
  })

  it.each(TERMINAL_THEMES.map((t) => [t.id, t] as const))(
    '%s: no grey backdrop (0..255 step 15) is worse than the white/black worst case',
    (_id, t) => {
      const fg = parseHex(t.theme.foreground!)!
      const tint = parseHex(t.theme.background!)!
      const a = glassTintAlpha(t.theme.foreground!, t.theme.background!)
      const worst = worstContrast(fg, tint, a)
      for (let g = 0; g <= 255; g += 15) {
        expect(contrastRatio(fg, composite(tint, [g, g, g], a))).toBeGreaterThanOrEqual(worst - 1e-9)
      }
    }
  )

  it('a text colour inside the composite range is caught (some backdrop matches it)', () => {
    // Mid-grey text on a black tint at 0.55: over black the composite is black, over white it is
    // ~#737373, and #404040 sits between them — a grey backdrop exists that erases it.
    const fg = parseHex('#404040')!
    expect(worstContrast(fg, [0, 0, 0], 0.55)).toBe(1)
    let min = Infinity
    for (let g = 0; g <= 255; g++) min = Math.min(min, contrastRatio(fg, composite([0, 0, 0], [g, g, g], 0.55)))
    expect(min).toBeLessThan(1.05)
  })

  it('every alpha above the answer passes too (non-monotonic contrast is handled)', () => {
    const fg = parseHex('#d4d4d4')!
    const tint = parseHex('#000000')!
    const a = glassTintAlpha('#d4d4d4', '#000000')
    for (let x = a; x <= 1; x += 0.01) {
      expect(contrastRatio(fg, composite(tint, WHITE, x))).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('clamps: an easy pair still gets the floor, an impossible pair goes opaque', () => {
    expect(glassTintAlpha('#ffffff', '#000000', 1.5)).toBe(GLASS_ALPHA_MIN)
    expect(glassTintAlpha('#777777', '#808080')).toBe(1)
    expect(glassTintAlpha('nope', '#000000')).toBe(GLASS_ALPHA_MAX)
  })
})

describe('glassChromeAlpha (Liquid Glass chrome, both app themes)', () => {
  // Read the real tokens, so a palette change re-proves the guarantee instead of drifting past it.
  const CSS = readFileSync(join(__dirname, '../styles.css'), 'utf8').replace(/\r\n/g, '\n')
  function block(selector: string): string {
    const start = CSS.indexOf(`${selector} {`)
    return CSS.slice(start, CSS.indexOf('\n}', start))
  }
  function token(body: string, name: string): string | undefined {
    return new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(body)?.[1].trim()
  }
  const dark = block(':root')
  const light = block(":root[data-theme='light']")
  const resolve = (theme: string, name: string): string => {
    const raw = token(theme, name) ?? token(dark, name)!
    const tint = token(theme, '--tint-rgb') ?? token(dark, '--tint-rgb')!
    return raw.replace('var(--tint-rgb)', tint)
  }

  it.each([
    ['dark', dark],
    ['light', light]
  ])('%s: --text on the glass --panel keeps 4.5:1 over a fine grey sweep, below opaque', (_n, theme) => {
    const text = parseCssColor(resolve(theme, '--text'))!
    const panel = parseCssColor(resolve(theme, '--panel'))!.rgb
    const a = glassChromeAlpha(resolve(theme, '--text'), resolve(theme, '--panel'))!
    expect(a).toBeGreaterThanOrEqual(GLASS_ALPHA_MIN)
    expect(a).toBeLessThan(1)
    for (let v = 0; v <= 255; v++) {
      expect(chromeContrast(text, panel, a, [v, v, v])).toBeGreaterThanOrEqual(4.5)
    }
    for (const b of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]] as const) {
      expect(chromeContrast(text, panel, a, b)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('parses the colour forms the tokens use', () => {
    expect(parseCssColor('rgba(58, 48, 38, 0.85)')).toEqual({ rgb: [58, 48, 38], alpha: 0.85 })
    expect(parseCssColor('#282828')).toEqual({ rgb: [40, 40, 40], alpha: 1 })
    expect(parseCssColor('rgb(1,2,3)')).toEqual({ rgb: [1, 2, 3], alpha: 1 })
    expect(glassChromeAlpha('nope', '#000')).toBeNull()
  })
})
