import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYSTEM_COLORS } from './lib/palette'
import { gitStatusColor } from './lib/gitStatusColors'

// The semantic colour system (styles.css `--sys-*` palette + `--state-*` / `--git-*` roles): every
// role resolves to a colour in every theme, the JS table and the CSS agree, and each meaning has
// ONE source that every surface drawing it reads.

const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n')
const CSS = read('styles.css')

/** The declarations of the first rule whose selector line matches exactly. */
function block(selector: string): Map<string, string> {
  const start = CSS.indexOf(`\n${selector} {\n`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  const end = CSS.indexOf('\n}\n', start)
  const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
  return new Map(Array.from(body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm), (m) => [m[1], m[2].trim()]))
}

/** Every rule with exactly this selector, merged in source order (later declarations win). */
function blocks(selector: string): Map<string, string> {
  const out = new Map<string, string>()
  let from = 0
  for (;;) {
    const start = CSS.indexOf(`\n${selector} {\n`, from)
    if (start < 0) return out
    const end = CSS.indexOf('\n}\n', start)
    const body = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '')
    for (const m of body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm)) out.set(m[1], m[2].trim())
    from = end
  }
}

/** The literal a token finally paints (var() chains substituted), for comparing meanings. */
function literal(name: string, tokens: Map<string, string>, depth = 0): string {
  const v = tokens.get(name) ?? ''
  if (depth > 10) return v
  return v.replace(/var\(\s*(--[a-z0-9-]+)\s*\)/g, (_, r: string) => literal(r, tokens, depth + 1)).toLowerCase()
}

const DARK = block(':root')
const LIGHT = new Map([...DARK, ...block(":root[data-theme='light']")])
const GLASS = blocks(":root[data-nt-glass='on']")
const THEMES = { dark: DARK, light: LIGHT }
const GLASS_THEMES = { dark: new Map([...DARK, ...GLASS]), light: new Map([...LIGHT, ...GLASS]) }

/** Follow var() chains; true when every reference bottoms out in a literal colour. */
function resolves(value: string, tokens: Map<string, string>, depth = 0): boolean {
  if (depth > 10) return false
  const refs = Array.from(value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g), (m) => m[1])
  if (refs.length === 0) return /#[0-9a-f]{3,8}\b|rgba?\(|transparent/i.test(value)
  return refs.every((r) => tokens.has(r) && resolves(tokens.get(r)!, tokens, depth + 1))
}

const ROLES = [
  '--state-working',
  '--state-attention',
  '--state-unread',
  '--state-error',
  '--state-success',
  '--state-warning',
  '--state-queued',
  '--state-automation',
  '--git-modified',
  '--git-added',
  '--git-deleted',
  '--git-renamed',
  '--git-conflict'
]

describe('palette tokens', () => {
  for (const [theme, tokens] of Object.entries(THEMES)) {
    it(`every semantic role resolves to a colour (${theme})`, () => {
      for (const role of ROLES) expect(resolves(tokens.get(role) ?? '', tokens), `${role} in ${theme}`).toBe(true)
    })

    it(`--sys-* matches lib/palette.ts (${theme})`, () => {
      for (const [name, hex] of Object.entries(SYSTEM_COLORS[theme as 'dark' | 'light'])) {
        expect(tokens.get(`--sys-${name}`), `--sys-${name}`).toBe(hex)
      }
    })
  }

  it('no rule outside the token blocks spells a status hue as a literal', () => {
    // The hues the audit found hand-typed at ~200 sites. Brand clay stays legal on the two
    // Claude-identity surfaces (subagent node, usage pill) and the onboarding decoration.
    const rules = CSS.slice(CSS.indexOf('\n}\n', CSS.search(/^:root\[data-theme='light'\]/m)))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*--sys-[a-z]+:.*$/gm, '') // palette declarations (the Increase Contrast block)
    const hits = rules.match(
      /rgba?\(\s*(255,\s*69,\s*58|10,\s*132,\s*255|48,\s*209,\s*88|255,\s*159,\s*10|191,\s*122,\s*240|217,\s*119,\s*87)|#(ff453a|30d158|32d74b|ff9f0a|bf7af0|ffb340|f85149|8e8e93)\b/gi
    )
    expect(hits ?? []).toEqual([])
  })
})

describe('Liquid Glass palette', () => {
  for (const [theme, tokens] of Object.entries(GLASS_THEMES)) {
    it(`every role still resolves under glass (${theme})`, () => {
      for (const role of ROLES) expect(resolves(tokens.get(role) ?? '', tokens), `${role} in ${theme}`).toBe(true)
    })

    it(`maps each meaning to its HIG colour (${theme})`, () => {
      expect(literal('--state-working', tokens)).toBe(literal('--accent', tokens))
      expect(literal('--state-attention', tokens)).toBe(literal('--sys-orange', tokens))
      expect(literal('--state-unread', tokens)).toBe(literal('--sys-green', tokens))
      expect(literal('--state-warning', tokens)).toBe(literal('--sys-yellow', tokens))
      expect(literal('--state-error', tokens)).toBe(literal('--sys-red', tokens))
    })

    it(`never uses one colour for two meanings (${theme})`, () => {
      const meanings = ['--state-working', '--state-attention', '--state-unread', '--state-warning', '--state-error']
      const hues = meanings.map((m) => literal(m, tokens))
      expect(new Set(hues).size).toBe(meanings.length)
    })
  }

  it('status labels on glass are ink over a tinted chip', () => {
    const rule = CSS.slice(CSS.indexOf(":root[data-nt-glass='on'] .term-node__status {"))
    const body = rule.slice(0, rule.indexOf('}'))
    expect(body).toContain('-webkit-text-fill-color: var(--text)')
    expect(body).toContain('color-mix(in srgb, currentColor')
  })
})

describe('git status colours have one source', () => {
  it('both git panels draw from lib/gitStatusColors', () => {
    for (const f of ['components/SourceControlPanel.tsx', 'components/git-history/GitHistoryCommitFiles.tsx']) {
      const src = read(f)
      expect(src, f).toContain('gitStatusColor(')
      expect(src, f).not.toMatch(/STATUS_COLOR|'#[0-9a-f]{6}'/i)
    }
  })

  it('every status resolves to a defined role token, unknown to the label colour', () => {
    for (const s of ['M', 'A', 'D', 'R', 'U']) {
      const v = gitStatusColor(s)
      expect(v).toMatch(/^var\(--git-/)
      expect(resolves(v, DARK)).toBe(true)
    }
    expect(gitStatusColor('??')).toBe('var(--text)')
  })
})

describe('minimap status strokes match the node glows', () => {
  const canvas = read('canvas/Canvas.tsx')
  const pairs = [
    ['working', "st?.state === 'working') return 'var(--state-working)'"],
    ['attention', "st?.state === 'blocked') return 'var(--state-attention)'"],
    ['unread', "st?.unread) return 'var(--state-unread)'"]
  ] as const

  for (const [state, stroke] of pairs) {
    it(`${state}: the canvas glow, the minimap stroke and its halo read --state-${state}`, () => {
      expect(canvas).toContain(stroke)
      const glow = CSS.slice(CSS.indexOf(`.react-flow__node:has(.term-node.${state})::after {`))
      expect(glow.slice(0, glow.indexOf('}'))).toContain(`var(--state-${state})`)
      const mm = CSS.slice(CSS.indexOf(`\n.minimap .mm-${state} {\n  filter`))
      expect(mm.slice(0, mm.indexOf('}'))).toContain(`var(--state-${state})`)
    })
  }
})

describe('Liquid Glass accessibility fallbacks', () => {
  /** Body of the first `@media <query> {` block (balanced braces). */
  const media = (query: string): string => {
    const start = CSS.indexOf(`@media ${query} {`)
    expect(start, query).toBeGreaterThanOrEqual(0)
    let depth = 0
    for (let i = CSS.indexOf('{', start); i < CSS.length; i++) {
      if (CSS[i] === '{') depth++
      else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i + 1)
    }
    return ''
  }

  it('Reduce Transparency drops blur, refraction and sheen on glass', () => {
    const m = media('(prefers-reduced-transparency: reduce)')
    expect(m).toContain(":root[data-nt-glass='on']")
    expect(m).toMatch(/--glass-blur:\s*none/)
    expect(m).toMatch(/--glass-sheen-image:\s*none/)
  })

  it('Increase Contrast strengthens edges and takes the HIG increased-contrast palette', () => {
    const m = media('(prefers-contrast: more)')
    expect(m).toMatch(/--glass-edge:\s*rgba\(var\(--tint-rgb\), 0\.5\)/)
    const light = m.slice(m.indexOf("[data-theme='light']"))
    const dark = m.slice(0, m.indexOf("[data-theme='light']"))
    for (const [name, hex] of Object.entries(SYSTEM_COLORS.darkContrast)) expect(dark).toContain(`--sys-${name}: ${hex};`)
    for (const [name, hex] of Object.entries(SYSTEM_COLORS.lightContrast)) expect(light).toContain(`--sys-${name}: ${hex};`)
  })

  it('Reduce Motion holds every state glow still', () => {
    const all = CSS.split('@media (prefers-reduced-motion: reduce) {').slice(1).join('')
    for (const state of ['unread', 'working', 'attention']) {
      const rule = all.slice(all.indexOf(`.react-flow__node:has(.term-node.${state})::after {`))
      expect(rule.slice(0, rule.indexOf('}')), state).toContain('animation: none')
    }
    expect(all).toMatch(/\.minimap \.mm-unread \{\s*animation: none/)
  })
})
