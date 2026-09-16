// Admin design tokens -> IronCalc `themeVariables` (admin-ui.md §"Theme").
//
// IronCalc sets every variable it is given as a CSS custom property on the
// root container, and the grid canvas re-reads a subset of them through
// `getComputedStyle` each time it is constructed. The values therefore have to
// be resolved colours, not `var(--tx)` indirections, so the mapping reads the
// admin's tokens off `document.documentElement` and hands over literals.
type ThemeVariables = Record<string, string>

const token = (styles: CSSStyleDeclaration, name: string, fallback: string): string =>
  styles.getPropertyValue(name).trim() || fallback

/** The nine-step grey ramp IronCalc's chrome uses, walked surface -> ink. */
const ramp = (steps: string[]): ThemeVariables => ({
  '--palette-grey-50': steps[0],
  '--palette-grey-100': steps[1],
  '--palette-grey-200': steps[2],
  '--palette-grey-300': steps[3],
  '--palette-grey-400': steps[4],
  '--palette-grey-500': steps[5],
  '--palette-grey-600': steps[6],
  '--palette-grey-700': steps[7],
  '--palette-grey-800': steps[8],
  '--palette-grey-900': steps[9],
  '--palette-grey-a100': steps[1],
  '--palette-grey-a200': steps[2],
  '--palette-grey-a400': steps[4],
  '--palette-grey-a700': steps[7],
})

export const spreadsheetThemeVariables = (root: HTMLElement): ThemeVariables => {
  const s = getComputedStyle(root)
  const dark = s.getPropertyValue('color-scheme').trim() !== 'light'
  const surface = token(s, '--panel', '#ffffff')
  const surface2 = token(s, '--main', '#f8fafc')
  const hover = token(s, '--main-hover', surface2)
  const ink = token(s, '--tx', '#111827')
  const ink2 = token(s, '--tx2', ink)
  const ink3 = token(s, '--tx3', ink2)
  const line = token(s, '--sep', '#e0e0e0')
  const lineStrong = token(s, '--border-strong', line)
  const accent = token(s, '--accent', '#7c3aed')
  const accentSoft = token(s, '--accent-soft', 'rgba(124, 58, 237, 0.16)')
  const accentHover = token(s, '--accent-hover', accent)
  const accentStrong = token(s, '--accent-strong', accent)
  const onAccent = token(s, '--on-accent', '#ffffff')
  const overlay = token(s, '--overlay', 'rgba(0, 0, 0, 0.08)')
  const font = token(s, '--font-family-body', 'system-ui, sans-serif')
  const fontSize = token(s, '--font-size-base', '0.9375rem')
  const greys = dark
    ? [surface, surface2, hover, line, lineStrong, ink3, ink3, ink2, ink2, ink]
    : [surface2, hover, line, line, lineStrong, ink3, ink3, ink2, ink2, ink]

  return {
    ...ramp(greys),
    // IronCalc reads `--palette-common-black` as the foreground (every toolbar
    // icon is `currentColor` under it, and `--black-04`/`--black-12` are
    // colour-mixes of it) and `--palette-common-white` as the surface the
    // canvas paints cells on. In a dark theme "white" is the admin's panel and
    // "black" is still the ink -- inverting the pair erases the toolbar.
    '--palette-common-black': ink,
    '--palette-common-white': surface,
    '--palette-error-contrast-text': onAccent,
    '--palette-error-dark': token(s, '--danger-strong', '#b91c1c'),
    '--palette-error-light': token(s, '--danger-soft', 'rgba(239, 68, 68, 0.12)'),
    '--palette-error-main': token(s, '--danger', '#ef4444'),
    '--palette-info-contrast-text': onAccent,
    '--palette-info-dark': token(s, '--info-text', '#0369a1'),
    '--palette-info-light': token(s, '--info-soft', 'rgba(56, 189, 248, 0.15)'),
    '--palette-info-main': token(s, '--info', '#1d9bd1'),
    '--palette-primary-contrast-text': onAccent,
    '--palette-primary-dark': accentStrong,
    '--palette-primary-light': accentSoft,
    '--palette-primary-main': accent,
    '--palette-secondary-contrast-text': onAccent,
    '--palette-secondary-dark': accentStrong,
    '--palette-secondary-light': accentSoft,
    '--palette-secondary-main': accentHover,
    '--palette-sheet-default-cell-font-family': font,
    '--palette-sheet-default-text-color': ink,
    '--palette-sheet-grid-color': line,
    '--palette-sheet-grid-separator-color': lineStrong,
    '--palette-sheet-header-background': surface2,
    '--palette-sheet-header-border-color': line,
    '--palette-sheet-header-corner-background': surface2,
    '--palette-sheet-header-font': `bold 12px ${font}`,
    '--palette-sheet-header-full-selected-background': accentSoft,
    '--palette-sheet-header-global-selector-color': overlay,
    '--palette-sheet-header-selected-background': hover,
    '--palette-sheet-header-selected-color': ink,
    '--palette-sheet-header-text-color': ink2,
    '--palette-sheet-outline-background-color': accentSoft,
    '--palette-sheet-outline-color': accent,
    '--palette-sheet-outline-editing-color': accentSoft,
    '--palette-success-contrast-text': onAccent,
    '--palette-success-dark': token(s, '--success-text', '#166534'),
    '--palette-success-light': token(s, '--success-soft', 'rgba(34, 197, 94, 0.15)'),
    '--palette-success-main': token(s, '--success', '#22c55e'),
    '--palette-warning-contrast-text': onAccent,
    '--palette-warning-dark': token(s, '--warning-text', '#92400e'),
    '--palette-warning-light': token(s, '--warning-soft', 'rgba(234, 179, 8, 0.15)'),
    '--palette-warning-main': token(s, '--warning', '#eab308'),
    '--typography-font-family': font,
    '--typography-font-size': fontSize,
  }
}
