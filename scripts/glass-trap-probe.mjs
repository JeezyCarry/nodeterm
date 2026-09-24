#!/usr/bin/env node

/**
 * Liquid Glass trap probe: finds surfaces that are see-through WITHOUT a working blur.
 *
 * A translucent fill only reads as glass when the content behind it is blurred. It is a TRAP when:
 *   - it has no blur of its own and no blurred ancestor behind it, or
 *   - it floats (absolute/fixed/sticky) over the nearest blurred or solid ancestor's content —
 *     that content is sharp, and a blur inside a blurred ancestor samples only its pixels, or
 *   - it has its own blur but sits inside a BACKDROP ROOT (an ancestor with backdrop-filter, filter,
 *     opacity < 1, mask, clip-path or a blend mode) and reaches outside that root's box: the part
 *     outside samples nothing, so whatever is behind it reads sharp through the tint.
 * `transform` and `isolation` are not backdrop roots (the React Flow viewport, `.dock`).
 *
 * Usage (a dev build with remote debugging, e.g. `--remote-debugging-port=9333`):
 *   node scripts/glass-trap-probe.mjs [--port 9333 | --ws ws://…] [--json]
 * Open the overlay under test first; the probe checks what is on screen. Exits 1 on any trap.
 * It only reads computed styles — it never clicks, types or changes state.
 */

// Runs in the page (serialised with toString). Keep it self-contained.
export function glassTrapProbe() {
  // Intentional full-window dims behind a modal, not glass.
  const SCRIMS = ['.palette-overlay', '.drawer-overlay', '.kanban-modal-scrim', '.confirm-overlay', '.tab-backdrop', '.ctx-backdrop', '.dock-backdrop']
  const MIN_AREA = 300
  const alphaOf = (c) => {
    if (!c || c === 'transparent') return 0
    const slash = c.match(/\/\s*([\d.]+%?)\s*\)$/)
    if (slash) return slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1])
    const m = c.match(/^rgba\(([^)]+)\)$/)
    if (m) return parseFloat(m[1].split(',')[3])
    return 1
  }
  const blurs = (cs) => !!cs && /blur\(/.test(cs.backdropFilter || cs.webkitBackdropFilter || '')
  const beforeOf = (el) => {
    const b = getComputedStyle(el, '::before')
    return b.content && b.content !== 'none' && b.display !== 'none' ? b : null
  }
  const isRoot = (el) => {
    const cs = getComputedStyle(el)
    return (
      (cs.backdropFilter && cs.backdropFilter !== 'none') ||
      cs.filter !== 'none' ||
      parseFloat(cs.opacity) < 1 ||
      (cs.maskImage && cs.maskImage !== 'none') ||
      (cs.webkitMaskImage && cs.webkitMaskImage !== 'none') ||
      cs.clipPath !== 'none' ||
      cs.mixBlendMode !== 'normal' ||
      /filter|opacity|mask|clip-path|mix-blend/.test(cs.willChange)
    )
  }
  const hasBlur = (el) => blurs(getComputedStyle(el)) || blurs(beforeOf(el))
  const floats = (el) => /absolute|fixed|sticky/.test(getComputedStyle(el).position)
  const opaque = (e) => alphaOf(getComputedStyle(e).backgroundColor) >= 0.9
  const inside = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1
  const name = (el) =>
    el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '')
  const visible = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false
    }
    return true
  }
  const vw = innerWidth
  const vh = innerHeight
  const traps = []
  const check = (el, pseudo) => {
    if (SCRIMS.some((s) => el.matches(s))) return
    const cs = pseudo ? beforeOf(el) : getComputedStyle(el)
    if (!cs) return
    const a = alphaOf(cs.backgroundColor)
    if (a < 0.02 || a >= 0.9) return
    // What shows is the box clipped by scrolling/clipping ancestors (a long settings list scrolls
    // inside its sheet; the part past the sheet's edge is not painted).
    const b = el.getBoundingClientRect()
    const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom, x: b.x, y: b.y, width: b.width, height: b.height }
    for (let e = el.parentElement; e; e = e.parentElement) {
      if (getComputedStyle(e).overflow === 'visible') continue
      const c = e.getBoundingClientRect()
      r.left = Math.max(r.left, c.left)
      r.top = Math.max(r.top, c.top)
      r.right = Math.min(r.right, c.right)
      r.bottom = Math.min(r.bottom, c.bottom)
    }
    const w = Math.min(r.right, vw) - Math.max(r.left, 0)
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0)
    if (w <= 0 || h <= 0 || w * h < MIN_AREA || !visible(el)) return
    // The ::before paints inside its element: its ancestor chain starts at the element itself.
    const chain = []
    for (let e = pseudo ? el : el.parentElement; e && e !== document.documentElement; e = e.parentElement) chain.push(e)
    const own = pseudo ? blurs(cs) : hasBlur(el)
    let why = null
    if (own) {
      const root = chain.find(isRoot)
      if (root && !inside(r, root.getBoundingClientRect())) why = `blur escapes backdrop root ${name(root)}`
    } else {
      // The nearest ancestor that paints something solid or blurred is what shows behind an
      // in-flow piece. A piece that FLOATS above that ancestor covers its content instead.
      const backIdx = chain.findIndex((e) => hasBlur(e) || opaque(e))
      if (backIdx < 0) why = 'no blur behind it'
      else {
        const back = chain[backIdx]
        const between = [el, ...chain.slice(0, backIdx)]
        if (!pseudo && between.some(floats)) why = `floats over ${name(back)}'s content`
        else if (!inside(r, back.getBoundingClientRect())) why = `outside ${name(back)}`
      }
    }
    if (why)
      traps.push({
        el: name(el) + (pseudo ? '::before' : ''),
        bg: cs.backgroundColor,
        why,
        box: [b.x, b.y, b.width, b.height].map(Math.round),
      })
  }
  for (const el of document.body.querySelectorAll('*')) {
    check(el, false)
    check(el, true)
  }
  return { glass: document.documentElement.dataset.ntGlass === 'on', traps }
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined)
  let ws = opt('--ws')
  if (!ws) {
    const port = opt('--port') ?? '9333'
    const pages = await (await fetch(`http://localhost:${port}/json`)).json()
    ws = pages.find((p) => p.type === 'page' && !p.url.includes('hud'))?.webSocketDebuggerUrl
    if (!ws) throw new Error(`no app page on port ${port}`)
  }
  const sock = new WebSocket(ws)
  const result = await new Promise((resolve, reject) => {
    sock.onerror = reject
    sock.onopen = () =>
      sock.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: `(${glassTrapProbe.toString()})()`, returnByValue: true },
        }),
      )
    sock.onmessage = (m) => {
      const r = JSON.parse(m.data)
      if (r.id !== 1) return
      sock.close()
      if (r.result?.exceptionDetails) reject(new Error(r.result.exceptionDetails.exception?.description))
      else resolve(r.result.result.value)
    }
  })
  if (args.includes('--json')) console.log(JSON.stringify(result))
  else {
    if (!result.glass) console.log('note: Liquid Glass is not on (data-nt-glass) — nothing glass to check')
    console.log(`${result.traps.length} trap(s)`)
    for (const t of result.traps) console.log(`  ${t.el}  ${t.bg}  ${t.why}  [${t.box.join(',')}]`)
  }
  process.exit(result.traps.length ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e.message)
  process.exit(2)
})
