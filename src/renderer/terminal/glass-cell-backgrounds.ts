import type { Terminal } from '@xterm/xterm'
import type { WebglAddon } from '@xterm/addon-webgl'
import { relativeLuminance } from '../lib/glassContrast'

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
 * alpha the original just wrote — the same private coupling a bundle patch would need, minus the
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

// xterm's packed attribute bits (common/buffer/Constants.ts).
const FG_INVERSE = 0x4000000
const CM_MASK = 0x3000000

/** ponytail: tuning knob, panel alpha = node tint alpha × this. 0.5 measured 5.6:1 at Readable
 *  over a bright backdrop (tui-glass-backgrounds.md), so 1 — lower only with a new contrast check. */
const CELL_ALPHA_SCALE = 1

/**
 * The alpha one background run gets on a glass terminal.
 * - inverse video (and the fake cursors TUIs draw with it) stays opaque;
 * - an attribute-only run (default bg + DIM/ITALIC/…) gets the theme background's alpha, which is
 *   what the rest of the viewport gets (0 under glass);
 * - a rendered bg that differs from the buffer cell's raw bg is a RENDERER override — selection,
 *   the block cursor, a search/decoration highlight — and stays opaque;
 * - a panel nearer the theme foreground than the background (a light bar on a dark theme) stays
 *   opaque, since fading it would move the text on it toward the tint;
 * - everything else is the app's own panel and follows the node's glass alpha, so the Glass slider
 *   and Reduce Transparency (alpha 1) apply to it like to the node.
 */
export function glassRectAlpha(
  fg: number,
  bg: number,
  cellBg: number,
  glassA: number,
  themeBgA: number,
  runLum: number,
  bgLum: number,
  fgLum: number
): number {
  if (fg & FG_INVERSE) return 1
  if ((bg & CM_MASK) === 0) return themeBgA
  if (bg !== cellBg) return 1
  if (Math.abs(runLum - bgLum) > Math.abs(runLum - fgLum)) return 1
  return Math.min(1, glassA * CELL_ALPHA_SCALE)
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
  _themeService?: { colors?: { background?: { rgba: number }; foreground?: { rgba: number } } }
}

/** Kept on the prototype, not in module state, so a hot-reloaded copy of this module re-wraps the
 *  ORIGINAL instead of stacking a second wrap over the first. */
const ORIGINAL = Symbol.for('nodeterm.glassCellBackgrounds.original')

const lum = (rgba: number): number => relativeLuminance([(rgba >>> 24) & 255, (rgba >>> 16) & 255, (rgba >>> 8) & 255])

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
    let scratch: { bg?: number } | undefined
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
      const glassA = cellAlpha.get(this._terminal)
      if (glassA === undefined) return
      const colors = this._themeService?.colors
      const back = colors?.background?.rgba
      const fore = colors?.foreground?.rgba
      if (back === undefined || fore === undefined) return
      const a = v.attributes // re-read: the original may have grown the array
      let cellBg = NaN // unknown = treated as a renderer override (stock opaque)
      if ((bg & CM_MASK) !== 0 && !(fg & FG_INVERSE)) {
        const buf = this._terminal.buffer.active
        scratch ??= buf.getNullCell() as unknown as { bg?: number }
        buf.getLine(buf.viewportY + y)?.getCell(startX, scratch as never)
        if (typeof scratch.bg === 'number') cellBg = scratch.bg
      }
      const k = glassRectAlpha(
        fg,
        bg,
        cellBg,
        glassA,
        (back & 255) / 255,
        relativeLuminance([a[offset + 4] * 255, a[offset + 5] * 255, a[offset + 6] * 255]),
        lum(back),
        lum(fore)
      )
      if (k >= 1) return
      // The canvas is premultiplied and the addon blends SRC_ALPHA/ONE_MINUS_SRC_ALPHA on the alpha
      // channel too, so writing (c, k) would store (c·k, k²). (c·√k, √k) stores exactly (c·k, k).
      const s = Math.sqrt(k)
      a[offset + 4] *= s
      a[offset + 5] *= s
      a[offset + 6] *= s
      a[offset + 7] = s
    }
    return true
  } catch {
    return false
  }
}
