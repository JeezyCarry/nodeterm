import { describe, expect, it } from 'vitest'
import { TERMINAL_THEMES } from '../terminal/themes'
import {
  GLASS_ALPHA_MAX,
  GLASS_ALPHA_MIN,
  composite,
  contrastRatio,
  glassTintAlpha,
  parseHex
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
