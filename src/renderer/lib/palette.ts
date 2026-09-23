/**
 * The Apple system colours (HIG color.md) for the few JS consumers that need a LITERAL — xterm
 * search decorations, canvas-drawn sprites, the notch HUD window (which does not load styles.css).
 * Everything that styles the DOM uses the `--sys-*` / `--state-*` tokens in styles.css instead;
 * `styles.palette.test.ts` pins those declarations to this table so the two cannot drift.
 */
export type SystemColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'mint'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'brown'
  | 'gray'

export const SYSTEM_COLORS: Record<'dark' | 'light', Record<SystemColor, string>> = {
  dark: {
    red: '#ff453a',
    orange: '#ff9f0a',
    yellow: '#ffd60a',
    green: '#30d158',
    mint: '#63e6e2',
    teal: '#40cbe0',
    cyan: '#64d2ff',
    blue: '#0a84ff',
    indigo: '#5e5ce6',
    purple: '#bf5af2',
    pink: '#ff375f',
    brown: '#ac8e68',
    gray: '#98989d'
  },
  light: {
    red: '#ff3b30',
    orange: '#ff9500',
    yellow: '#ffcc00',
    green: '#34c759',
    mint: '#00c7be',
    teal: '#30b0c7',
    cyan: '#32ade6',
    blue: '#007aff',
    indigo: '#5856d6',
    purple: '#af52de',
    pink: '#ff2d55',
    brown: '#a2845e',
    gray: '#8e8e93'
  }
}

/** Terminal find highlight (Apple's find highlight is yellow; the current match is brighter). */
export const FIND_DECORATIONS = {
  matchBackground: `${SYSTEM_COLORS.dark.yellow}55`,
  activeMatchBackground: SYSTEM_COLORS.dark.orange,
  matchOverviewRuler: SYSTEM_COLORS.dark.yellow,
  activeMatchColorOverviewRuler: SYSTEM_COLORS.dark.orange
}
