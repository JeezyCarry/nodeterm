import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Liquid Glass is a THEME, so its CSS must (a) be unreachable unless `data-nt-glass` is on, and
 * (b) neutralise the per-node accent colour, which arrives as INLINE styles and so needs
 * `!important`. Parsed from the real stylesheet rather than asserted as substrings, so a rule that
 * moves out of the gate or loses its override goes red.
 */
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const GATE = ":root[data-nt-glass='on']"

interface Rule {
  selector: string
  body: string
}
const rules: Rule[] = []
{
  const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(noComments))) rules.push({ selector: m[1].replace(/\s+/g, ' ').trim(), body: m[2] })
}
const gated = (needle: string): Rule[] =>
  rules.filter((r) => r.selector.startsWith(GATE) && r.selector.includes(needle))

describe('Liquid Glass stylesheet', () => {
  it('uses the chrome fill only behind the data-nt-glass gate', () => {
    const users = rules.filter((r) => r.body.includes('--glass-chrome-bg') && !r.selector.startsWith(GATE))
    expect(users.map((r) => r.selector)).toEqual([])
  })

  it('neutralises the inline per-node top border and colour dot', () => {
    const node = gated('.term-node').find((r) => r.selector === `${GATE} .term-node`)
    expect(node?.body).toMatch(/border-top-color:\s*var\(--glass-edge\)\s*!important/)
    const dot = gated('.term-node__color')[0]
    expect(dot?.body).toMatch(/background:\s*transparent\s*!important/)
  })

  it('keeps selection visible with neutral ink, not the accent', () => {
    const sel = gated('.term-node.selected')[0]
    expect(sel?.body).toMatch(/border-color:\s*var\(--text\)\s*!important/)
    expect(sel?.body).not.toMatch(/--accent/)
  })

  it('keeps the unread state perceivable (its own border survives the neutral top edge)', () => {
    const unread = gated('.term-node.unread')[0]
    expect(unread?.body).toMatch(/border-top-color:\s*var\(--accent\)\s*!important/)
  })

  it('never blurs a container nested in a blurred one', () => {
    const blurred = gated('').filter((r) => /backdrop-filter:\s*var\(--glass-blur\)/.test(r.body))
    for (const nested of ['.dock-menu', '.dock-menu__sub', '.usage-refresh', '.sessions-icon-cluster']) {
      expect(blurred.some((r) => r.selector.includes(nested))).toBe(false)
    }
  })
})
