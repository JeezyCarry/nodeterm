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

const DARK = block(':root')
const LIGHT = new Map([...DARK, ...block(":root[data-theme='light']")])
const THEMES = { dark: DARK, light: LIGHT }

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
    const hits = rules.match(
      /rgba?\(\s*(255,\s*69,\s*58|10,\s*132,\s*255|48,\s*209,\s*88|255,\s*159,\s*10|191,\s*122,\s*240|217,\s*119,\s*87)|#(ff453a|30d158|32d74b|ff9f0a|bf7af0|ffb340|f85149|8e8e93)\b/gi
    )
    expect(hits ?? []).toEqual([])
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
      const mm = CSS.slice(CSS.lastIndexOf(`.minimap .mm-${state} {`))
      expect(mm.slice(0, mm.indexOf('}'))).toContain(`var(--state-${state})`)
    })
  }
})
