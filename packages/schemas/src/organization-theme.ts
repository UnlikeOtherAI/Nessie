import { z } from 'zod'

import { alpha, contrastRatio, hexToOklch, hueDistance, set, solve } from './colour.js'

/**
 * An organisation's own colour scheme
 * (docs/plans/2026-09-05-organisation-custom-theme.md).
 *
 * An administrator authors four seeds; the other forty-eight colour tokens are
 * derived here. Not a token-by-token editor — coherence between tokens is the
 * craft of the built-in themes, and it is what a formula can guarantee and a
 * form cannot — and not a bare accent swap, which would leave Sandstone's warm
 * sand surfaces under a corporate blue.
 *
 * **Colours and nothing else.** The schema is `.strict()`, so type, radii,
 * spacing and motion cannot be authored, stored or sent: those tokens are
 * declared once on `:root` in `admin/src/styles.css` and stay there.
 */

export const HexColourSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, 'Enter a colour like #1a73e8')

export const OrganizationThemeSchema = z
  .object({
    appearance: z.enum(['light', 'dark']),
    accent: HexColourSchema,
    surface: HexColourSchema,
    sidebar: HexColourSchema.nullable(),
  })
  .strict()
export type OrganizationTheme = z.infer<typeof OrganizationThemeSchema>

/**
 * The names every `[data-theme]` block in `admin/src/styles.css` redeclares, in
 * the order those blocks declare them. `admin/test/organization-theme-tokens.test.ts`
 * pins this against the stylesheet: a token added to the built-ins without a
 * derivation rule here fails CI rather than rendering as the `@property`
 * registration's `initial-value: #000000`.
 */
export const THEME_TOKENS = [
  'rail', 'sb', 'sb-active', 'ink', 'muted', 'line', 'main', 'main-hover', 'sep', 'border-strong',
  'tx', 'tx2', 'tx3', 'lnk', 'accent', 'accent-soft', 'danger', 'warning', 'thinking', 'executing',
  'panel', 'panel-soft', 'accent-hover', 'accent-strong', 'on-accent',
  'surface-inverse', 'surface-inverse-2',
  'success', 'success-soft', 'success-border', 'success-text',
  'danger-soft', 'danger-border', 'danger-text', 'danger-strong',
  'warning-soft', 'warning-border', 'warning-text',
  'info', 'info-soft', 'info-border', 'info-text',
  'overlay-weak', 'overlay', 'overlay-strong', 'scrim-weak', 'scrim', 'scrim-strong',
] as const

export type ThemeTokenName = (typeof THEME_TOKENS)[number]
export type ThemeTokens = Record<ThemeTokenName, string>

export type ThemeCheckId =
  | 'surface-band'
  | 'surface-chroma'
  | 'sidebar-band'
  | 'accent-on-main'
  | 'accent-on-panel'
  | 'accent-on-sidebar'
  | 'accent-near-danger'

export type ThemeCheck = {
  floor?: number
  id: ThemeCheckId
  label: string
  level: 'blocking' | 'warning'
  message: string
  ratio?: number
}

export type EvaluatedTheme = {
  checks: ThemeCheck[]
  colorScheme: 'light' | 'dark'
  tokens: ThemeTokens
  valid: boolean
}

/**
 * Status colours are fixed per appearance — red stays red whatever the brand —
 * and are the audited values from the `midnight` (dark) and `daylight` (light)
 * blocks in `admin/src/styles.css`.
 */
const STATUS: Record<'dark' | 'light', Record<string, string>> = {
  dark: {
    danger: '#ef4444',
    'danger-soft': 'rgba(239,68,68,0.12)',
    'danger-border': 'rgba(239,68,68,0.35)',
    'danger-text': '#fca5a5',
    'danger-strong': '#dc2626',
    warning: '#f59e0b',
    'warning-soft': 'rgba(245,158,11,0.15)',
    'warning-border': 'rgba(245,158,11,0.35)',
    'warning-text': '#fde68a',
    success: '#22c55e',
    'success-soft': 'rgba(34,197,94,0.15)',
    'success-border': 'rgba(34,197,94,0.45)',
    'success-text': '#86efac',
    info: '#38bdf8',
    'info-soft': 'rgba(56,189,248,0.15)',
    'info-border': 'rgba(56,189,248,0.4)',
    'info-text': '#7dd3fc',
  },
  light: {
    danger: '#dc2626',
    'danger-soft': 'rgba(220,38,38,0.1)',
    'danger-border': 'rgba(220,38,38,0.32)',
    'danger-text': '#b91c1c',
    'danger-strong': '#b91c1c',
    warning: '#d97706',
    'warning-soft': 'rgba(217,119,6,0.14)',
    'warning-border': 'rgba(217,119,6,0.34)',
    'warning-text': '#92400e',
    success: '#16a34a',
    'success-soft': 'rgba(22,163,74,0.12)',
    'success-border': 'rgba(22,163,74,0.35)',
    'success-text': '#166534',
    info: '#0284c7',
    'info-soft': 'rgba(2,132,199,0.12)',
    'info-border': 'rgba(2,132,199,0.35)',
    'info-text': '#0369a1',
  },
}

const clampC = (value: number): number => Math.min(0.05, Math.max(0.012, value))

const round1 = (value: number): number => Math.round(value * 10) / 10

/** The sidebar an admin did not seed: a sibling of nebula's and ocean's. */
const deriveSidebar = (
  surface: ReturnType<typeof hexToOklch>,
  accent: ReturnType<typeof hexToOklch>,
  dark: boolean,
): string =>
  dark
    ? set(surface.L - 0.02, Math.min(0.04, Math.max(accent.C * 0.4, 0.015)), accent.h)
    : set(Math.min(1, surface.L + 0.02), Math.min(0.01, surface.C), accent.h)

/**
 * The forty-eight tokens for one seed.
 *
 * Every text token is *solved* for contrast against the surfaces it lands on
 * rather than fixed, which is what makes the floors in §8.2 of the plan true by
 * construction for any seed that passes `themeChecks`.
 */
const deriveTokens = (theme: OrganizationTheme): ThemeTokens => {
  const dark = theme.appearance === 'dark'
  const S = hexToOklch(theme.surface)
  const A = hexToOklch(theme.accent)
  const sidebar = theme.sidebar ?? deriveSidebar(S, A, dark)
  const SB = hexToOklch(sidebar)
  // Every grey leans toward one hue, as the built-ins' do. A derived light
  // sidebar clamps to white, whose reported hue is arithmetic noise, so the
  // chroma guard sends that case to the accent instead.
  const H = theme.sidebar !== null && SB.C >= 0.01 ? SB.h : A.h

  const rail = dark
    ? set(SB.L + 0.04, Math.min(0.1, SB.C * 1.6 + 0.01), H)
    : set(SB.L - 0.04, Math.min(0.04, SB.C * 1.6 + 0.01), H)
  const main = theme.surface
  const mainHover = dark ? set(S.L + 0.04, S.C, S.h) : set(S.L - 0.04, S.C, S.h)
  const panel = dark
    ? set(S.L + 0.04, S.C, S.h)
    : set(Math.min(1, S.L + 0.02), S.C * 0.5, S.h)
  const sep = dark
    ? set(S.L + 0.07, S.C, S.h)
    : set(S.L - 0.1, Math.min(0.05, S.C * 1.5 + 0.005), S.h)
  const borderStrong = dark
    ? set(S.L + 0.18, clampC(SB.C), H)
    : set(S.L - 0.2, clampC(SB.C), H)

  const targets = [main, panel, sidebar, rail] as const
  const tx = dark
    ? solve(0.92, 1, [main, panel], 7, 0.005, H)
    : solve(0.23, -1, [main, panel], 7, Math.min(0.02, SB.C), H)
  const tx2 = dark ? solve(0.83, 1, targets, 4.5, 0.01, H) : solve(0.4, -1, targets, 4.5, 0.02, H)
  const tx3 = dark ? solve(0.66, 1, targets, 4.5, 0.015, H) : solve(0.53, -1, targets, 4.5, 0.02, H)
  const muted = dark ? solve(0.56, 1, [main], 3, 0.03, H) : solve(0.55, -1, [main], 3, 0.03, H)
  // `--ink` is the text on `--surface-inverse`, which is always light.
  const ink = dark ? set(0.24, Math.min(0.04, Math.max(0.012, SB.C)), H) : tx

  // The accent is used verbatim: it is the brand's colour, and a palette that
  // fails a floor is refused rather than quietly shifted into one that is not
  // the brand's.
  const onAccent = contrastRatio(theme.accent, '#ffffff') >= 4.5 ? '#ffffff' : '#000000'
  const accentHover = A.L >= 0.4 ? set(A.L - 0.06, A.C, A.h) : set(A.L + 0.06, A.C, A.h)
  const accentStrong = A.L >= 0.4 ? set(A.L - 0.12, A.C, A.h) : set(A.L + 0.12, A.C, A.h)
  const status = STATUS[theme.appearance]!

  return {
    rail,
    sb: sidebar,
    'sb-active': dark ? accentHover : theme.accent,
    ink,
    muted,
    line: dark ? alpha(tx2, 0.16) : alpha(tx, 0.14),
    main,
    'main-hover': mainHover,
    sep,
    'border-strong': borderStrong,
    tx,
    tx2,
    tx3,
    lnk: solve(A.L, dark ? 1 : -1, [main, panel], 4.5, A.C, A.h),
    accent: theme.accent,
    'accent-soft': alpha(theme.accent, dark ? 0.16 : 0.12),
    danger: status['danger']!,
    warning: status['warning']!,
    thinking: dark ? set(0.8, Math.min(A.C, 0.12), A.h) : accentStrong,
    executing: status['success']!,
    panel,
    'panel-soft': alpha(theme.accent, 0.08),
    'accent-hover': accentHover,
    'accent-strong': accentStrong,
    'on-accent': onAccent,
    'surface-inverse': dark ? set(0.98, 0.01, H) : panel,
    'surface-inverse-2': dark ? set(0.95, 0.015, H) : rail,
    success: status['success']!,
    'success-soft': status['success-soft']!,
    'success-border': status['success-border']!,
    'success-text': status['success-text']!,
    'danger-soft': status['danger-soft']!,
    'danger-border': status['danger-border']!,
    'danger-text': status['danger-text']!,
    'danger-strong': status['danger-strong']!,
    'warning-soft': status['warning-soft']!,
    'warning-border': status['warning-border']!,
    'warning-text': status['warning-text']!,
    info: status['info']!,
    'info-soft': status['info-soft']!,
    'info-border': status['info-border']!,
    'info-text': status['info-text']!,
    'overlay-weak': dark ? 'rgba(255,255,255,0.06)' : alpha(tx, 0.05),
    overlay: dark ? 'rgba(255,255,255,0.1)' : alpha(tx, 0.08),
    'overlay-strong': dark ? 'rgba(255,255,255,0.2)' : alpha(tx, 0.14),
    'scrim-weak': dark ? 'rgba(0,0,0,0.1)' : alpha(tx, 0.08),
    scrim: dark ? 'rgba(0,0,0,0.2)' : alpha(tx, 0.18),
    'scrim-strong': dark ? 'rgba(0,0,0,0.5)' : alpha(tx, 0.45),
  }
}

const ACCENT_UI_FLOOR = 3

/**
 * Why these are refusals rather than adjustments: the bands exist because every
 * text token is global — the sidebar draws `--tx` on `--sb` — so a light
 * sidebar under a dark theme cannot read whatever the derivation does, and the
 * accent is the brand's own colour, which we decline to shift on its owner's
 * behalf.
 */
const themeChecks = (theme: OrganizationTheme, tokens: ThemeTokens): ThemeCheck[] => {
  const dark = theme.appearance === 'dark'
  const S = hexToOklch(theme.surface)
  const A = hexToOklch(theme.accent)
  const checks: ThemeCheck[] = []

  if (dark ? S.L > 0.35 : S.L < 0.85) {
    checks.push({
      id: 'surface-band',
      label: 'Background',
      level: 'blocking',
      message: dark
        ? 'For a dark theme the background must be dark — something like #14171c.'
        : 'For a light theme the background must be light — something like #f8fafc.',
    })
  }
  if (S.C > 0.05) {
    checks.push({
      id: 'surface-chroma',
      label: 'Background',
      level: 'blocking',
      message: 'The background is too colourful for text to sit on. Keep it near neutral and put '
        + 'the colour in the accent or the sidebar.',
    })
  }
  if (theme.sidebar !== null) {
    const SB = hexToOklch(theme.sidebar)
    if (dark ? SB.L > 0.36 : SB.L < 0.8) {
      checks.push({
        id: 'sidebar-band',
        label: 'Sidebar',
        level: 'blocking',
        message: 'The sidebar must be as dark (or light) as the background — they share the same '
          + 'text colours.',
      })
    }
  }
  for (const [id, surface, label] of [
    ['accent-on-main', tokens.main, 'Accent on background'],
    ['accent-on-panel', tokens.panel, 'Accent on cards'],
  ] as const) {
    const ratio = contrastRatio(theme.accent, surface)
    if (ratio < ACCENT_UI_FLOOR) {
      checks.push({
        floor: ACCENT_UI_FLOOR,
        id,
        label,
        level: 'blocking',
        message: `The accent doesn't stand out against the background (${round1(ratio)}:1, needs `
          + '3:1). Choose a brighter or darker accent, or adjust the background.',
        ratio: round1(ratio),
      })
    }
  }

  const sidebarRatio = contrastRatio(theme.accent, tokens.sb)
  if (sidebarRatio < ACCENT_UI_FLOOR) {
    checks.push({
      floor: ACCENT_UI_FLOOR,
      id: 'accent-on-sidebar',
      label: 'Accent on sidebar',
      level: 'warning',
      message: `The highlighted item in the navigation will be faint (${round1(sidebarRatio)}:1).`,
      ratio: round1(sidebarRatio),
    })
  }
  // 18° so that Sandstone's terracotta — 22° away and plainly not red — is not
  // flagged, while Rose (8°) and Sunset (13°) are.
  if (A.C >= 0.08 && hueDistance(A.h, hexToOklch(tokens.danger).h) <= 18) {
    checks.push({
      id: 'accent-near-danger',
      label: 'Accent and errors',
      level: 'warning',
      message: 'Your accent is close to the red used for errors, so destructive buttons will look '
        + 'like ordinary ones.',
    })
  }

  return checks
}

export const evaluateOrganizationTheme = (theme: OrganizationTheme): EvaluatedTheme => {
  const tokens = deriveTokens(theme)
  const checks = themeChecks(theme, tokens)
  return {
    checks,
    colorScheme: theme.appearance,
    tokens,
    valid: !checks.some((check) => check.level === 'blocking'),
  }
}

/**
 * The one CSS rule `ThemeProvider` keeps in `<head>`. Keyed on `data-theme`
 * rather than written as inline custom properties on the root element, so that
 * picking a built-in makes it inert instead of leaving it beating every
 * `[data-theme]` block in the stylesheet.
 *
 * `:root[data-theme=…]` rather than the bare attribute selector the built-in
 * blocks use, because this rule's position in `<head>` is not ours to control:
 * the first-paint script appends it before the stylesheet loads, and at equal
 * specificity the later rule wins — so a bare `[data-theme="organization"]`
 * lost every token back to `:root`'s defaults and painted the sign-in screen
 * Nebula. One extra specificity point makes source order irrelevant, and only
 * one `data-theme` value ever matches at a time, so it outranks nothing else.
 */
export const organizationThemeCss = (evaluated: EvaluatedTheme): string => {
  const declarations = THEME_TOKENS.map((token) => `--${token}:${evaluated.tokens[token]};`).join('')
  return `:root[data-theme="organization"]{color-scheme:${evaluated.colorScheme};${declarations}}`
}
