// Admin design tokens -> IronCalc `themeVariables` (admin-ui.md §"Theme").
//
// IronCalc sets every variable it is given as a CSS custom property on the root
// container, and the grid canvas re-reads a subset of them through
// `getComputedStyle` each time `WorksheetCanvas` is constructed. The values
// therefore have to be *resolved* colours, not `var(--tx)` indirections, so the
// mapping reads the admin's tokens off the document element and hands over
// literals.
//
// Two corrections the Spike C screenshots forced (decisions.md §"Spike C/D"):
//
//  1. `darkThemeVariables` does **not** exist in the published package. There
//     is one mapping, and because it reads whichever admin theme is active it
//     covers all eleven of them rather than the two the plan assumed.
//  2. `--palette-common-black` is a **foreground** token, not a surface. Every
//     toolbar icon is `currentColor` beneath it and `--black-04`/`--black-12`
//     are `color-mix`es of it, so mapping it to a dark surface erased the whole
//     toolbar — invisible to assertions, caught only by a screenshot.

/** The 58 keys `IronCalcThemeVariables` declares, in the package's own order. */
export const SPREADSHEET_THEME_KEYS = [
  '--typography-font-family',
  '--typography-font-size',
  '--palette-common-black',
  '--palette-common-white',
  '--palette-primary-main',
  '--palette-primary-light',
  '--palette-primary-dark',
  '--palette-primary-contrast-text',
  '--palette-secondary-main',
  '--palette-secondary-light',
  '--palette-secondary-dark',
  '--palette-secondary-contrast-text',
  '--palette-error-main',
  '--palette-error-light',
  '--palette-error-dark',
  '--palette-error-contrast-text',
  '--palette-warning-main',
  '--palette-warning-light',
  '--palette-warning-dark',
  '--palette-warning-contrast-text',
  '--palette-info-main',
  '--palette-info-light',
  '--palette-info-dark',
  '--palette-info-contrast-text',
  '--palette-success-main',
  '--palette-success-light',
  '--palette-success-dark',
  '--palette-success-contrast-text',
  '--palette-grey-50',
  '--palette-grey-100',
  '--palette-grey-200',
  '--palette-grey-300',
  '--palette-grey-400',
  '--palette-grey-500',
  '--palette-grey-600',
  '--palette-grey-700',
  '--palette-grey-800',
  '--palette-grey-900',
  '--palette-grey-a100',
  '--palette-grey-a200',
  '--palette-grey-a400',
  '--palette-grey-a700',
  '--palette-sheet-header-corner-background',
  '--palette-sheet-header-text-color',
  '--palette-sheet-header-background',
  '--palette-sheet-header-global-selector-color',
  '--palette-sheet-header-selected-background',
  '--palette-sheet-header-full-selected-background',
  '--palette-sheet-header-selected-color',
  '--palette-sheet-header-border-color',
  '--palette-sheet-grid-color',
  '--palette-sheet-grid-separator-color',
  '--palette-sheet-default-text-color',
  '--palette-sheet-outline-color',
  '--palette-sheet-outline-editing-color',
  '--palette-sheet-outline-background-color',
  '--palette-sheet-default-cell-font-family',
  '--palette-sheet-header-font',
] as const

export type SpreadsheetThemeKey = (typeof SPREADSHEET_THEME_KEYS)[number]
export type SpreadsheetThemeVariables = Record<SpreadsheetThemeKey, string>

const token = (styles: CSSStyleDeclaration, name: string, fallback: string): string =>
  styles.getPropertyValue(name).trim() || fallback

type Ramp = [string, string, string, string, string, string, string, string, string, string]

/** The ten-step grey ramp IronCalc's chrome walks, surface -> ink. */
const ramp = (steps: Ramp) => ({
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

/**
 * Reads the admin's own tokens off `root` and returns every IronCalc theme
 * variable as a resolved literal. Pure over its argument: the test drives it
 * with a jsdom element carrying a known token set.
 */
export const spreadsheetThemeVariables = (root: HTMLElement): SpreadsheetThemeVariables => {
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
  // A dark theme's panel is *lighter* than its page, so the ramp starts one
  // step further in; a light theme starts on the page behind the panel.
  const greys: Ramp = dark
    ? [surface, surface2, hover, line, lineStrong, ink3, ink3, ink2, ink2, ink]
    : [surface2, hover, line, line, lineStrong, ink3, ink3, ink2, ink2, ink]

  return {
    ...ramp(greys),
    // See the header note: "black" is the ink in every theme, "white" is the
    // surface the canvas paints cells on. Inverting the pair erases the toolbar.
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
