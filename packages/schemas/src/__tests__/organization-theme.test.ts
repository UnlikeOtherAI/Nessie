import assert from 'node:assert/strict'
import test from 'node:test'

import { contrastRatio, hexToOklch, normaliseHex, oklchToHex } from '../colour.js'
import {
  evaluateOrganizationTheme,
  organizationThemeCss,
  OrganizationThemeSchema,
  THEME_TOKENS,
  type OrganizationTheme,
} from '../organization-theme.js'

const seed = (over: Partial<OrganizationTheme> = {}): OrganizationTheme => ({
  appearance: 'light',
  accent: '#2563eb',
  surface: '#f8fafc',
  sidebar: null,
  ...over,
})

test('OKLCH round-trips the colours the derivation starts from', () => {
  assert.equal(Math.round(hexToOklch('#ffffff').L * 1000) / 1000, 1)
  assert.equal(Math.round(hexToOklch('#000000').L * 1000) / 1000, 0)

  const nebulaAccent = hexToOklch('#7c3aed')
  assert.ok(Math.abs(nebulaAccent.L - 0.54) < 0.01, `L was ${nebulaAccent.L}`)
  assert.ok(Math.abs(nebulaAccent.C - 0.25) < 0.01, `C was ${nebulaAccent.C}`)
  assert.ok(Math.abs(nebulaAccent.h - 293) < 1, `h was ${nebulaAccent.h}`)

  for (const hex of ['#ffffff', '#000000', '#7c3aed', '#2563eb', '#b45309', '#0f766e']) {
    assert.equal(oklchToHex(hexToOklch(hex)), hex)
  }
})

test('a hex is normalised to one lowercase spelling, so equality is colour equality', () => {
  assert.equal(normaliseHex('#ABC'), '#aabbcc')
  assert.equal(normaliseHex('  #2563EB '), '#2563eb')
  assert.equal(normaliseHex('rebeccapurple'), null)
  assert.equal(normaliseHex('#12345'), null)
})

test('the seed carries colours and nothing else', () => {
  assert.equal(OrganizationThemeSchema.safeParse(seed()).success, true)
  // `.strict()` is the guard that keeps type, radii and spacing unauthorable.
  const withFont = { ...seed(), fontFamily: 'Comic Sans' }
  assert.equal(OrganizationThemeSchema.safeParse(withFont).success, false)
  assert.equal(OrganizationThemeSchema.safeParse({ ...seed(), accent: '#ABC' }).success, false)
})

const GRID: OrganizationTheme[] = (['#2563eb', '#611f69', '#0f766e', '#b45309', '#e4002b', '#475569']
  .flatMap((accent) => [
    seed({ accent, appearance: 'light', surface: '#f8fafc' }),
    seed({ accent, appearance: 'light', surface: '#ffffff', sidebar: '#f1f5f9' }),
    seed({ accent, appearance: 'dark', surface: '#0b1416' }),
    seed({ accent, appearance: 'dark', surface: '#141414', sidebar: '#1c1c1c' }),
  ]))

test('every seed in the grid derives every token, and derivation is deterministic', () => {
  for (const theme of GRID) {
    const evaluated = evaluateOrganizationTheme(theme)
    for (const token of THEME_TOKENS) {
      const value = evaluated.tokens[token]
      assert.ok(value, `${token} missing for ${JSON.stringify(theme)}`)
      assert.match(value, /^(#[0-9a-f]{6}|rgba\([0-9]+,[0-9]+,[0-9]+,[0-9.]+\))$/)
    }
    assert.deepEqual(evaluateOrganizationTheme(theme), evaluated)
  }
})

test('the contrast floors hold for every valid seed, by construction', () => {
  for (const theme of GRID) {
    const { tokens, valid } = evaluateOrganizationTheme(theme)
    if (!valid) continue
    const where = JSON.stringify(theme)
    const atLeast = (floor: number, colour: string, on: readonly string[], name: string): void => {
      for (const surface of on) {
        const ratio = contrastRatio(colour, surface)
        assert.ok(ratio >= floor, `${name} was ${ratio.toFixed(2)} on ${surface} for ${where}`)
      }
    }
    atLeast(7, tokens.tx, [tokens.main, tokens.panel], '--tx')
    atLeast(4.5, tokens.tx2, [tokens.main, tokens.panel, tokens.sb, tokens.rail], '--tx2')
    atLeast(4.5, tokens.tx3, [tokens.main, tokens.panel, tokens.sb, tokens.rail], '--tx3')
    atLeast(4.5, tokens.lnk, [tokens.main, tokens.panel], '--lnk')
    atLeast(4.5, tokens['on-accent'], [tokens.accent], '--on-accent')
    atLeast(3, tokens.muted, [tokens.main], '--muted')
  }
})

test('a brand accent is used verbatim and refused rather than adjusted', () => {
  const valid = evaluateOrganizationTheme(seed({ accent: '#611f69', surface: '#ffffff' }))
  assert.equal(valid.tokens.accent, '#611f69')
  assert.equal(valid.valid, true)

  const tooFaint = evaluateOrganizationTheme(seed({ appearance: 'dark', accent: '#1f2937', surface: '#0b1416' }))
  assert.equal(tooFaint.valid, false)
  const blocking = tooFaint.checks.find((check) => check.id === 'accent-on-main')
  assert.equal(blocking?.level, 'blocking')
  assert.equal(blocking?.floor, 3)
  assert.ok((blocking?.ratio ?? 0) < 3)
  assert.match(blocking?.message ?? '', /needs 3:1/)
  // The accent it refused is still the one the admin typed.
  assert.equal(tooFaint.tokens.accent, '#1f2937')
})

test('the bands refuse a background or sidebar that fights the appearance', () => {
  const lightOnDark = evaluateOrganizationTheme(seed({ appearance: 'dark', surface: '#f8fafc' }))
  assert.equal(lightOnDark.valid, false)
  assert.match(
    lightOnDark.checks.find((check) => check.id === 'surface-band')?.message ?? '',
    /dark theme the background must be dark/,
  )

  const darkOnLight = evaluateOrganizationTheme(seed({ appearance: 'light', surface: '#0b1416' }))
  assert.match(
    darkOnLight.checks.find((check) => check.id === 'surface-band')?.message ?? '',
    /light theme the background must be light/,
  )

  const midSidebar = evaluateOrganizationTheme(
    seed({ appearance: 'dark', accent: '#60a5fa', surface: '#1e293b', sidebar: '#334155' }),
  )
  assert.equal(midSidebar.valid, false)
  assert.equal(midSidebar.checks.find((check) => check.id === 'sidebar-band')?.level, 'blocking')

  const colourfulSurface = evaluateOrganizationTheme(seed({ surface: '#bfdbfe' }))
  assert.equal(colourfulSurface.checks.find((check) => check.id === 'surface-chroma')?.level, 'blocking')
})

test('warnings are advice: the palette stays valid', () => {
  const nearRed = evaluateOrganizationTheme(seed({ appearance: 'dark', accent: '#e4002b', surface: '#141414' }))
  assert.equal(nearRed.valid, true)
  assert.equal(nearRed.checks.find((check) => check.id === 'accent-near-danger')?.level, 'warning')

  // Sandstone's terracotta is 22° from red and must not be flagged.
  const terracotta = evaluateOrganizationTheme(seed({ accent: '#b45309', surface: '#f1e9dc' }))
  assert.equal(terracotta.checks.some((check) => check.id === 'accent-near-danger'), false)
})

test('the CSS is one whitespace-free rule declaring every token', () => {
  const css = organizationThemeCss(evaluateOrganizationTheme(seed({ appearance: 'dark', surface: '#0b1416' })))
  assert.equal(/\s/.test(css), false)
  // `:root[…]` deliberately, not the bare attribute selector: this rule's
  // position in <head> is not ours to control, and at equal specificity the
  // later rule wins.
  assert.ok(css.startsWith(':root[data-theme="organization"]{color-scheme:dark;'))
  assert.ok(css.endsWith('}'))
  assert.equal(css.match(/--[a-z0-9-]+:/g)?.length, THEME_TOKENS.length)
  assert.equal(THEME_TOKENS.length, 48)
})
