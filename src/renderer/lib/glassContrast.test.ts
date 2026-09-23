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
  worstContrast,
  GLASS_CLEAR_ALPHA,
  GLASS_READABLE_TICK,
  GLASS_TINTED_ALPHA,
  glassRefraction,
  glassSheen,
  glassSliderAlpha,
  glassTint,
  resolveGlassSlider,
  glassSurfaceAlpha,
  snapGlassSlider,
  stepGlassSlider
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

describe('Glass slider (Clear ↔ Tinted)', () => {
  const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
  const body = (sel: string): string => {
    const i = css.indexOf(`\n${sel} {\n`)
    return css.slice(i, css.indexOf('\n}\n', i))
  }
  const tok = (b: string, n: string) => new RegExp(`\\n\\s*${n}:\\s*([^;]+);`).exec(b)?.[1].trim()
  const dark = body(':root')
  const light = body(":root[data-theme='light']")
  const chrome = (b: string): number => {
    const tint = tok(b, '--tint-rgb') ?? tok(dark, '--tint-rgb')!
    const text = (tok(b, '--text') ?? tok(dark, '--text')!).replace('var(--tint-rgb)', tint)
    return glassChromeAlpha(text, tok(b, '--panel')!)!
  }
  const surfaces: Array<[string, number]> = [
    ['chrome dark', chrome(dark)],
    ['chrome light', chrome(light)],
    ...TERMINAL_THEMES.map((t) => [t.id, glassTintAlpha(t.theme.foreground!, t.theme.background!)] as [string, number])
  ]

  it.each(surfaces)('%s: the Readable tick is exactly the computed 4.5:1 alpha', (_id, readable) => {
    expect(glassSliderAlpha(GLASS_READABLE_TICK, readable)).toBeCloseTo(readable, 10)
  })

  it.each(surfaces)('%s: alpha rises monotonically from Clear to Tinted', (_id, readable) => {
    let prev = -1
    for (let i = 0; i <= 100; i++) {
      const a = glassSliderAlpha(i / 100, readable)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
    expect(glassSliderAlpha(0, readable)).toBe(GLASS_CLEAR_ALPHA)
    expect(glassSliderAlpha(1, readable)).toBe(Math.max(readable, GLASS_TINTED_ALPHA))
  })

  it('an untouched or hand-mangled setting is the Readable tick; numbers clamp', () => {
    for (const v of [null, undefined, 'x', Number.NaN, Infinity]) expect(resolveGlassSlider(v)).toBe(GLASS_READABLE_TICK)
    expect(resolveGlassSlider(-3)).toBe(0)
    expect(resolveGlassSlider(7)).toBe(1)
  })

  it('the sheen appears only left of the tick; refraction fades to nothing at Tinted', () => {
    expect(glassSheen(0)).toBe(1)
    for (const t of [GLASS_READABLE_TICK, 0.85, 1]) expect(glassSheen(t)).toBe(0)
    expect(glassRefraction(0)).toBeGreaterThan(glassRefraction(GLASS_READABLE_TICK))
    expect(glassRefraction(1)).toBe(0)
  })

  it('a terminal tint follows the slider', () => {
    const t = TERMINAL_THEMES.find((x) => x.id === 'nodeterm-dark') ?? TERMINAL_THEMES[0]
    const at = (s: number) => Number(/, ([\d.]+)\)$/.exec(glassTint(t.theme, s)!.background)![1])
    expect(at(0)).toBeLessThan(at(GLASS_READABLE_TICK))
    expect(at(GLASS_READABLE_TICK)).toBeCloseTo(glassTintAlpha(t.theme.foreground!, t.theme.background!), 3)
    expect(at(1)).toBeGreaterThanOrEqual(at(GLASS_READABLE_TICK))
  })
})

describe('accessibility outranks the Glass slider', () => {
  it('Reduce Transparency is opaque; Increase Contrast pins to Tinted', () => {
    expect(glassSurfaceAlpha(0, 0.7, { reduceTransparency: true, moreContrast: false })).toBe(1)
    expect(glassSurfaceAlpha(0, 0.7, { reduceTransparency: false, moreContrast: true })).toBe(glassSliderAlpha(1, 0.7))
    expect(glassSurfaceAlpha(0.3, 0.7)).toBe(glassSliderAlpha(0.3, 0.7))
  })
})

describe('Glass slider detent (macOS tick-mark feel)', () => {
  it('a drag within ±0.03 of the tick lands on it', () => {
    expect(snapGlassSlider(GLASS_READABLE_TICK + 0.03)).toBe(GLASS_READABLE_TICK)
    expect(snapGlassSlider(GLASS_READABLE_TICK - 0.02)).toBe(GLASS_READABLE_TICK)
    expect(snapGlassSlider(0.5)).toBe(0.5)
  })

  it('arrow keys step 0.05 and stop on the tick when they cross it', () => {
    expect(stepGlassSlider(0.5, 1)).toBeCloseTo(0.55, 10)
    expect(stepGlassSlider(0.68, 1)).toBe(GLASS_READABLE_TICK)
    expect(stepGlassSlider(0.72, -1)).toBe(GLASS_READABLE_TICK)
    expect(stepGlassSlider(GLASS_READABLE_TICK, 1)).toBeCloseTo(0.75, 10)
    expect(stepGlassSlider(1, 1)).toBe(1)
    expect(stepGlassSlider(0, -1)).toBe(0)
  })
})
