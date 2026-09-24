import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Liquid Glass is OPT-IN per surface: a translucent glass fill is only ever handed to a surface
 * that also gets a working blur. Visual QA rounds 2 and 3 found eleven surfaces that were
 * see-through with no blur — terminal text read sharp through menus, drawers, pickers and
 * tooltips — because the shared panel tokens themselves resolved to the fill, which reached every
 * floating surface nobody had listed.
 *
 * The rule checked here: every rule that paints a translucent glass fill (as a background or by
 * assigning it to a custom property that surfaces paint) must, for each of its selectors, either
 * carry a backdrop-filter itself or target an element that a blur rule also targets (the same
 * classes, or its paired `::before` glass layer). A token assignment on `:root` targets no
 * surface in particular, so it always fails. The live half of the check — backdrop roots, which
 * CSS alone cannot see — is `scripts/glass-trap-probe.mjs` (see CLAUDE.md, Liquid Glass chrome).
 */
const FILL = /var\(--(glass-chrome-bg|glass-control-bg|term-glass-bg|term-glass-header-bg)\)/
const PAINT = /(?:^|;)\s*(background(?:-color)?|--[\w-]+)\s*:([^;]*)/g
const BLUR = /(?:^|;)\s*(?:-webkit-)?backdrop-filter\s*:\s*(?!none)[^;]*blur/

/** In-flow pieces that only stack on their own blurred surface, never over other content. */
const IN_FLOW: Record<string, string> = {
  '.kanban-modal__termwrap--glass': 'the card-modal terminal fills the blurred .kanban-modal',
  '.term-node--glass .term-node__header': 'the header row of its own blurred glass node',
}

interface Rule {
  selectors: string[]
  body: string
}

function parse(css: string): Rule[] {
  const out: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  const src = css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push({ selectors: splitTop(m[1].replace(/\s+/g, ' ').trim()), body: m[2] })
  return out
}

/** Split on commas outside parentheses. */
function splitTop(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/** The subject compound of a selector, one per `:is(…)` alternative, each as its class set plus
 *  its pseudo-element. `:not(…)`, `:hover` & co. do not change which element is painted. */
function subjects(selector: string): { classes: Set<string>; pseudo: string }[] {
  // The last compound: split on descendant/child combinators outside parentheses.
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) start = i + 1
  }
  const compound = selector.slice(start)
  const pseudo = /::([\w-]+)/.exec(compound)?.[1] ?? ''
  // A leading `:is(a, b)` lists alternatives; whatever follows it (`:hover`, `::before`) applies to each.
  let alts = [classesOf(compound)]
  if (compound.startsWith(':is(')) {
    let d = 0
    let end = 3
    while (end < compound.length && !(compound[end] === ')' && --d === 0)) if (compound[end++] === '(') d++
    const rest = classesOf(compound.slice(end + 1))
    alts = splitTop(compound.slice(4, end)).map((a) => new Set([...subjects(a)[0].classes, ...rest]))
  }
  return alts.map((classes) => ({ classes, pseudo }))
}

function classesOf(compound: string): Set<string> {
  const bare = compound.replace(/:(not|is|where|has)\((?:[^()]|\([^()]*\))*\)/g, '')
  return new Set([...bare.matchAll(/\.([\w-]+)/g)].map((c) => c[1]))
}

/** Every selector that paints a glass fill without a blur of its own or a paired blur rule. */
function glassFillsWithoutBlur(css: string): string[] {
  const rules = parse(css)
  const blurred = rules
    .filter((r) => BLUR.test(r.body))
    .flatMap((r) => r.selectors.flatMap(subjects))
    .filter((s) => s.classes.size > 0)
  const covered = (s: { classes: Set<string>; pseudo: string }): boolean =>
    blurred.some(
      (b) => (b.pseudo === s.pseudo || b.pseudo === 'before') && [...b.classes].every((c) => s.classes.has(c))
    )
  const bad: string[] = []
  for (const r of rules) {
    const paints = [...r.body.matchAll(PAINT)].some((d) => FILL.test(d[2]))
    if (!paints || BLUR.test(r.body)) continue
    for (const sel of r.selectors) {
      if (Object.keys(IN_FLOW).some((k) => sel.endsWith(k))) continue
      if (!subjects(sel).every(covered)) bad.push(sel)
    }
  }
  return bad
}

describe('Liquid Glass: no translucent fill without a blur', () => {
  const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')

  it('every glass fill in styles.css is paired with a working blur', () => {
    expect(glassFillsWithoutBlur(CSS)).toEqual([])
  })

  it('catches the pre-opt-in shape: panel tokens redefined to the fill on :root', () => {
    const tokens = `:root[data-nt-glass='on'] { --panel: var(--glass-chrome-bg); --surface-raised: var(--glass-chrome-bg); }`
    expect(glassFillsWithoutBlur(tokens)).toEqual([":root[data-nt-glass='on']"])
  })

  it('catches an unlisted surface given the fill, and accepts a listed or ::before-layered one', () => {
    const css = `
      :root[data-nt-glass='on'] :is(.menu, .drawer) { background: var(--glass-chrome-bg); backdrop-filter: var(--glass-text-blur); }
      :root[data-nt-glass='on'] .drawer:hover { background: linear-gradient(red, red), var(--glass-chrome-bg); }
      :root[data-nt-glass='on'] .host::before { background: var(--glass-chrome-bg); backdrop-filter: blur(20px); }
      :root[data-nt-glass='on'] .picker { background: var(--glass-chrome-bg); }
      :root[data-nt-glass='on'] .host { --x: var(--glass-control-bg); }
      :root[data-nt-glass='on'] .tip { background: var(--glass-chrome-bg); backdrop-filter: none; }`
    expect(glassFillsWithoutBlur(css)).toEqual([":root[data-nt-glass='on'] .picker", ":root[data-nt-glass='on'] .tip"])
  })

  it('the shared surface tokens are never redefined under the glass gate', () => {
    const redefined = parse(CSS)
      .filter((r) => r.selectors.some((s) => s.startsWith(":root[data-nt-glass='on']")))
      .flatMap((r) => [...r.body.matchAll(/(?:^|;)\s*(--(?:panel|panel-header|panel-2|surface-[\w-]+|tabbar-bg))\s*:/g)].map((d) => d[1]))
    expect(redefined).toEqual([])
  })
})
