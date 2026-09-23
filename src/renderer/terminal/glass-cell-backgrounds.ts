import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { composite, contrastRatio, relativeLuminance, worstContrast } from '../lib/glassContrast'

/**
 * Cell backgrounds on a Liquid Glass terminal become glass instead of opaque slabs.
 *
 * addon-webgl 0.18.0 paints every background rectangle at alpha 1 (`RectangleRenderer.
 * _updateRectangle`: `$a = 1`), whatever the colour came from. Under glass the viewport itself is
 * transparent, so two things read as black/grey cards over the wallpaper:
 *  - app-painted backgrounds (Grok's full-screen `48;2;20;20;20`, Codex's composer, Claude's
 *    user bubble), and
 *  - attribute-only runs: DIM / ITALIC / HAS_EXTENDED live in the bg word, so a dim run on the
 *    DEFAULT background still gets a rectangle, filled with the theme background at alpha 1
 *    (Codex's all-dim header box). That half is an xterm bug for any `allowTransparency` user.
 *
 * xterm has no option for either (`allowTransparency` is all there is, and palette alpha is
 * ignored), so this wraps the private `_updateRectangle` on the shared prototype and rewrites the
 * colour the original just wrote — the same private coupling a bundle patch would need, minus the
 * postinstall and Vite pre-bundle cache. Fail-open like `dom-renderer-spacing.ts`: a build that
 * renamed anything keeps stock rendering. `glass-cell-backgrounds.test.ts` pins the addon version
 * and every private name used here.
 *
 * Only terminals given an alpha through `setGlassCellAlpha` are touched; for every other terminal
 * the wrap returns right after the original, so non-glass output is byte-identical.
 *
 * Ceiling: the DOM renderer fallback (WebGL budget exhausted / context lost) keeps opaque explicit
 * backgrounds — its inline truecolor `background-color` cannot be re-alpha'd from CSS.
 */

type Rgb = readonly [number, number, number]

// xterm's packed attribute bits (common/buffer/Constants.ts).
const FG_INVERSE = 0x4000000
const CM_MASK = 0x3000000
const CM_P16 = 0x1000000
const CM_P256 = 0x2000000
const CM_RGB = 0x3000000

/**
 * How a background run renders on glass: `'stock'` = the renderer's own opaque rectangle, `'panel'`
 * = the app's own background (→ `glassPanelFill`), or a number = the THEME background at that alpha.
 * - inverse video (and the fake cursors TUIs draw with it) is stock;
 * - an attribute-only run (default bg + DIM/ITALIC/…) gets the theme background's alpha, which is
 *   what the rest of the viewport gets (0 under glass);
 * - a rendered bg that differs from the buffer cell's raw bg is a RENDERER override — selection,
 *   the block cursor, a search/decoration highlight — and is stock.
 */
export function classifyRun(fg: number, bg: number, cellBg: number, themeBgA: number): 'stock' | 'panel' | number {
  if (fg & FG_INVERSE) return 'stock'
  if ((bg & CM_MASK) === 0) return themeBgA
  if (bg !== cellBg) return 'stock'
  return 'panel'
}

/** OKLab (L, a, b) of an sRGB colour, 0..255 channels. */
export function oklab([r, g, b]: Rgb): [number, number, number] {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

/** ponytail: tuning knobs. Panel overlay alpha = PANEL_K × OKLab distance(panel, theme bg), clamped.
 *  K = 1 puts Claude's #3a3a3a bubble on #1e1e1e at 0.11 white and Grok's #141414 screen at 0.044
 *  black; raise K for bolder panels (the contrast check below still holds). */
const PANEL_K = 1
const PANEL_ALPHA_MIN = 0.04
const PANEL_ALPHA_MAX = 0.22
/** OKLab distance under which a panel IS the theme background (drawn as nothing). */
const PANEL_DEAD_ZONE = 0.02
/** OKLab chroma above which a panel keeps its own hue (a coloured status bar) instead of going grey. */
const PANEL_CHROMA_MIN = 0.04
/** Glyphs under this contrast on the app's own opaque panel are decoration (a dim prompt chevron),
 *  not text — unprotected, like ANSI colours on plain glass. */
const TEXT_MIN_CONTRAST = 3

/**
 * An app panel as a vibrancy fill: a gentle lift or sink of the glass, NEVER a second slab of the
 * node's tint (drawing the panel colour at the tint alpha stacked the two, and #3a3a3a over a bright
 * wallpaper read as a dark smudge).
 *
 * The panel colour C is judged against the theme background B: the overlay's alpha is
 * `PANEL_K × OKLab distance`, clamped to [0.04, 0.22], independent of the node alpha `t` (the Glass
 * slider keeps meaning the node's glass). Its colour: C itself when C is clearly chromatic (a
 * coloured bar stays coloured), otherwise neutral — white for a lift, black for a sink.
 *
 * A neutral move AWAY from the text (a sink on a dark theme) only adds contrast. A move TOWARD it
 * (a lift on a dark theme, a sink on a light one) is where the guarantee lives: at or right of the
 * Readable tick the overlay is the glass's own composite over the extreme backdrop (`B·t + white·
 * (1−t)` for a dark-theme lift), so it lifts wherever the backdrop leaves room and can never push
 * the composite past the glass's worst case — the theme foreground keeps exactly the plain glass's
 * 4.5:1. Left of the tick (no guarantee there, as on the plain glass) it slides toward pure white in
 * proportion to how far the glass already is from 4.5:1, so it is continuous at the tick.
 *
 * Every text colour on the run is then checked (glyphs under `TEXT_MIN_CONTRAST` on the opaque
 * panel are decoration, e.g. a dim prompt chevron):
 *  - text of INVERTED polarity (dark text on a dark theme — the panel is what makes it readable,
 *    e.g. a light bar) must keep min(4.5, its contrast on the opaque panel) over ANY backdrop;
 *  - other text, while the guarantee is on, must fare no worse than on the plain glass around it.
 * A panel that fails returns null: opaque, exactly the app's own panel.
 *
 * Returns the fill (0..255 colour, alpha) or null for opaque. `alpha` 0 = draw nothing.
 */
export function glassPanelFill(
  c: Rgb,
  theme: { bg: Rgb; fg: Rgb },
  t: number,
  texts: readonly Rgb[]
): { rgb: Rgb; alpha: number } | null {
  if (t >= 1) return null // Reduce Transparency: the app's panels, opaque
  const [lc, ac, bc] = oklab(c)
  const [lb, ab, bb] = oklab(theme.bg)
  const dist = Math.hypot(lc - lb, ac - ab, bc - bb)
  if (dist < PANEL_DEAD_ZONE) return { rgb: c, alpha: 0 }
  const alpha = Math.min(PANEL_ALPHA_MAX, Math.max(PANEL_ALPHA_MIN, PANEL_K * dist))
  const glassWorst = worstContrast(theme.fg, theme.bg, t)
  const guaranteed = glassWorst >= 4.5
  const fgLight = relativeLuminance(theme.fg) > relativeLuminance(theme.bg)
  let rgb: Rgb
  if (Math.hypot(ac, bc) > PANEL_CHROMA_MIN) {
    rgb = c
  } else {
    const lift = lc > lb
    const extreme: Rgb = lift ? [255, 255, 255] : [0, 0, 0]
    if (lift !== fgLight) {
      rgb = extreme
    } else {
      const ceiling = composite(theme.bg, extreme, t)
      const toward = guaranteed ? 0 : Math.min(1, (4.5 - glassWorst) / 3.5)
      rgb = composite(extreme, ceiling, toward)
    }
  }
  // Over backdrop X the node shows G(X) = B·t + X·(1−t); the panel paints rgb·alpha over it. Both
  // are affine in X, so the composite's luminance range is spanned by X = black and X = white.
  const lo = composite(rgb, composite(theme.bg, [0, 0, 0], t), alpha)
  const hi = composite(rgb, composite(theme.bg, [255, 255, 255], t), alpha)
  const [llo, lhi] = [relativeLuminance(lo), relativeLuminance(hi)].sort((x, y) => x - y)
  const lbg = relativeLuminance(theme.bg)
  for (const f of texts) {
    const own = contrastRatio(f, c)
    if (own < TEXT_MIN_CONTRAST) continue
    const lf = relativeLuminance(f)
    const inverted = lf > lbg !== fgLight
    if (!inverted && !guaranteed) continue
    const worst = lf > llo && lf < lhi ? 1 : Math.min(contrastRatio(f, lo), contrastRatio(f, hi))
    const need = inverted ? Math.min(4.5, own) : Math.min(own, worstContrast(f, theme.bg, t))
    if (worst < need - 1e-9) return null
  }
  return { rgb, alpha }
}

/** The node's glass alpha per terminal; absent = not glass = stock rendering. */
const cellAlpha = new WeakMap<Terminal, number>()

/** Set (or clear with null) a terminal's glass alpha. True when it changed — the caller then owes a
 *  model rebuild (`term.clearTextureAtlas()`), since backgrounds are only recomputed for changed
 *  cells. */
export function setGlassCellAlpha(term: Terminal, alpha: number | null): boolean {
  if (alpha === null) return cellAlpha.delete(term)
  if (cellAlpha.get(term) === alpha) return false
  cellAlpha.set(term, alpha)
  return true
}

type Vertices = { attributes: Float32Array }
type UpdateRectangle = (
  v: Vertices,
  offset: number,
  fg: number,
  bg: number,
  startX: number,
  endX: number,
  y: number
) => void
interface RectangleRendererLike {
  _terminal: Terminal
  _themeService?: {
    colors?: { background?: { rgba: number }; foreground?: { rgba: number }; ansi?: { rgba: number }[] }
  }
}
interface CellLike {
  bg?: number
  fg?: number
  getChars?(): string
}

/** Kept on the prototype, not in module state, so a hot-reloaded copy of this module re-wraps the
 *  ORIGINAL instead of stacking a second wrap over the first. */
const ORIGINAL = Symbol.for('nodeterm.glassCellBackgrounds.original')

const rgbOf = (rgba: number): Rgb => [(rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255]

/** Write `rgb` (0..255) at `alpha` into a rectangle's colour slots. The canvas is premultiplied and
 *  the addon blends SRC_ALPHA/ONE_MINUS_SRC_ALPHA on the alpha channel too, so writing (c, k) would
 *  store (c·k, k²); (c·√k, √k) stores exactly (c·k, k). */
function writeFill(a: Float32Array, offset: number, rgb: Rgb, alpha: number): void {
  const s = Math.sqrt(alpha)
  a[offset + 4] = (rgb[0] / 255) * s
  a[offset + 5] = (rgb[1] / 255) * s
  a[offset + 6] = (rgb[2] / 255) * s
  a[offset + 7] = s
}

/** Wrap the addon's rectangle renderer once (all instances share the prototype). Call after
 *  `term.loadAddon(addon)`, when the renderer exists. Returns whether the wrap is in place. */
export function installGlassCellBackgrounds(addon: WebglAddon): boolean {
  try {
    const rr = (addon as unknown as { _renderer?: { _rectangleRenderer?: { value?: object } } })._renderer
      ?._rectangleRenderer?.value
    const proto = rr && (Object.getPrototypeOf(rr) as Record<PropertyKey, unknown>)
    if (!proto) return false
    const orig = (proto[ORIGINAL] ?? proto._updateRectangle) as UpdateRectangle | undefined
    if (typeof orig !== 'function') return false
    proto[ORIGINAL] = orig
    let scratch: CellLike | undefined
    proto._updateRectangle = function (
      this: RectangleRendererLike,
      v: Vertices,
      offset: number,
      fg: number,
      bg: number,
      startX: number,
      endX: number,
      y: number
    ): void {
      orig.call(this, v, offset, fg, bg, startX, endX, y)
      const t = cellAlpha.get(this._terminal)
      if (t === undefined) return
      const colors = this._themeService?.colors
      const back = colors?.background?.rgba
      const fore = colors?.foreground?.rgba
      if (back === undefined || fore === undefined) return
      const a = v.attributes // re-read: the original may have grown the array
      let line: { getCell(x: number, cell: never): unknown } | undefined
      let cellBg = NaN // unknown = treated as a renderer override (stock opaque)
      if ((bg & CM_MASK) !== 0 && !(fg & FG_INVERSE)) {
        const buf = this._terminal.buffer.active
        scratch ??= buf.getNullCell() as unknown as CellLike
        line = buf.getLine(buf.viewportY + y)
        line?.getCell(startX, scratch as never)
        if (typeof scratch.bg === 'number') cellBg = scratch.bg
      }
      const kind = classifyRun(fg, bg, cellBg, (back & 255) / 255)
      if (kind === 'stock') return
      if (typeof kind === 'number') {
        if (kind < 1) writeFill(a, offset, rgbOf(back), kind)
        return
      }
      // The run's text colours: a run spans cells of one bg but any fg, and the fg the renderer
      // passes is only the first cell's.
      const texts: Rgb[] = []
      let lastFg = -1
      for (let x = startX; x < endX && line && scratch; x++) {
        line.getCell(x, scratch as never)
        const f = scratch.fg
        const ch = scratch.getChars?.() ?? ''
        if (typeof f !== 'number' || f === lastFg || ch === '' || ch === ' ') continue
        lastFg = f
        const mode = f & CM_MASK
        texts.push(
          mode === CM_RGB
            ? rgbOf((f & 0xffffff) << 8)
            : (mode === CM_P16 || mode === CM_P256) && colors?.ansi?.[f & 0xff]
              ? rgbOf(colors.ansi[f & 0xff].rgba)
              : rgbOf(fore)
        )
      }
      const run: Rgb = [a[offset + 4] * 255, a[offset + 5] * 255, a[offset + 6] * 255]
      const fill = glassPanelFill(run, { bg: rgbOf(back), fg: rgbOf(fore) }, t, texts)
      if (fill) writeFill(a, offset, fill.rgb, fill.alpha)
    }
    return true
  } catch {
    return false
  }
}
