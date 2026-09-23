/**
 * The contrast guarantee behind glass terminal nodes.
 *
 * A glass node paints the terminal theme's background as a translucent tint over whatever is
 * behind it (a wallpaper, the canvas), so the effective background of every glyph is
 * `tint·a + backdrop·(1−a)`. The backdrop is unknowable — any pixel of any wallpaper — so the alpha
 * is chosen against the two extremes: pure white and pure black. Every other backdrop pixel lies
 * between them channel-wise, and so does its composite.
 *
 * Compositing is in gamma-encoded sRGB, the way the browser blends an rgba() fill; the WCAG
 * relative luminance is computed on the result.
 *
 * Pure and platform-free (no DOM), so it runs under vitest's node environment.
 */

type Rgb = readonly [number, number, number]

/** `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha ignored) → 0..255 channels; null when unparseable. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function channelLuminance(c: number): number {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** `tint` at `alpha` over `backdrop`, in sRGB (what `background: rgba(...)` renders). */
export function composite(tint: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => tint[i] * alpha + backdrop[i] * (1 - alpha)) as unknown as Rgb
}

export const GLASS_ALPHA_MIN = 0.55
export const GLASS_ALPHA_MAX = 0.95
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
const STEP = 0.005

function passes(fg: Rgb, tint: Rgb, alpha: number, minRatio: number): boolean {
  return (
    contrastRatio(fg, composite(tint, WHITE, alpha)) >= minRatio &&
    contrastRatio(fg, composite(tint, BLACK, alpha)) >= minRatio
  )
}

/**
 * The smallest tint alpha at which `fg` keeps `minRatio` contrast over BOTH a white and a black
 * backdrop, floored at 0.55 so the glass never gets clearer than that.
 *
 * Scanned DOWN from opaque, stopping at the first failure. Contrast is not monotonic in alpha when
 * the fg's luminance lies between the backdrop's and the tint's (light text on a dark tint over
 * white: the composite passes through the text's own grey), so a scan up from 0 could return an
 * alpha whose neighbours above it fail. Scanning down returns the bottom of the contiguous passing
 * range that reaches opaque, so every alpha at or above the answer passes.
 *
 * The design ceiling is 0.95, and for every built-in theme but the two Solarized ones the answer
 * sits under it (measured: 0.62–0.885). The guarantee outranks the ceiling, though — readable text
 * is the load-bearing requirement and "never fully opaque" is a look:
 *  - Solarized Dark (opaque contrast 4.75) needs 0.985, and gets it.
 *  - Solarized Light is 4.13:1 OPAQUE — under 4.5 before any glass — so no alpha passes. It gets 1:
 *    the glass can only match the theme's own contrast, and 1 is the one alpha that never makes it
 *    worse. `glassContrast.test.ts` pins both as named exceptions.
 * Unparseable colours get the ceiling.
 */
export function glassTintAlpha(fg: string, tint: string, minRatio = 4.5): number {
  const f = parseHex(fg)
  const t = parseHex(tint)
  if (!f || !t) return GLASS_ALPHA_MAX
  let lowest = Infinity
  for (let i = Math.round(1 / STEP); i >= 0; i--) {
    const a = i * STEP
    if (!passes(f, t, a, minRatio)) break
    lowest = a
  }
  if (lowest === Infinity) return 1
  return Math.max(GLASS_ALPHA_MIN, lowest)
}

export interface GlassTint {
  /** The node's glass fill, `rgba(r, g, b, a)`. */
  background: string
  /** The header's extra layer on top of it — slightly more opaque in total. */
  header: string
}

/** CSS for a theme's glass, or null when its background is not a colour we can parse. */
export function glassTint(theme: { background?: string; foreground?: string }): GlassTint | null {
  const bg = theme.background ? parseHex(theme.background) : null
  if (!bg) return null
  const alpha = glassTintAlpha(theme.foreground ?? '#ffffff', theme.background!)
  const rgb = bg.join(', ')
  return {
    background: `rgba(${rgb}, ${alpha.toFixed(3)})`,
    header: `rgba(${rgb}, 0.35)`
  }
}
