/**
 * Colour maths for the organisation theme derivation
 * (docs/plans/2026-09-05-organisation-custom-theme.md §1.4).
 *
 * Lives in `@nessie/schemas` for the same reason `secret-precedence.ts` does:
 * the API refuses a palette that fails a contrast floor and the admin previews
 * the very same palette, so both ends must compute the identical answer. Two
 * derivations would be two themes.
 *
 * OKLCH for every lightness/chroma step — perceptually uniform, so "−0.06 L for
 * hover" reads the same on a navy and on an orange — and WCAG 2.x relative
 * luminance for every contrast ratio, because that is what audits measure.
 * Matrices are Björn Ottosson's published OKLab values, written out rather than
 * pulled from a dependency: the maths is a hundred lines and `zod` stays the
 * only thing this package depends on.
 */

export type Rgb = { b: number; g: number; r: number }
export type Oklch = { C: number; h: number; L: number }

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** Lowercase `#rrggbb`. The one spelling stored, so string equality is colour equality. */
export const normaliseHex = (value: string): string | null => {
  const trimmed = value.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed)
  if (short) return `#${short[1]!}${short[1]!}${short[2]!}${short[2]!}${short[3]!}${short[3]!}`
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : null
}

export const hexToRgb = (hex: string): Rgb => ({
  r: Number.parseInt(hex.slice(1, 3), 16) / 255,
  g: Number.parseInt(hex.slice(3, 5), 16) / 255,
  b: Number.parseInt(hex.slice(5, 7), 16) / 255,
})

const channelToHex = (value: number): string =>
  Math.round(clamp01(value) * 255).toString(16).padStart(2, '0')

export const rgbToHex = ({ b, g, r }: Rgb): string =>
  `#${channelToHex(r)}${channelToHex(g)}${channelToHex(b)}`

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

const toGamma = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055

const linearRgbToOklab = ({ b, g, r }: Rgb): { a: number; b: number; L: number } => {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const l2 = Math.cbrt(l)
  const m2 = Math.cbrt(m)
  const s2 = Math.cbrt(s)
  return {
    L: 0.2104542553 * l2 + 0.793617785 * m2 - 0.0040720468 * s2,
    a: 1.9779984951 * l2 - 2.428592205 * m2 + 0.4505937099 * s2,
    b: 0.0259040371 * l2 + 0.7827717662 * m2 - 0.808675766 * s2,
  }
}

const oklabToLinearRgb = ({ a, b, L }: { a: number; b: number; L: number }): Rgb => {
  const l2 = L + 0.3963377774 * a + 0.2158037573 * b
  const m2 = L - 0.1055613458 * a - 0.0638541728 * b
  const s2 = L - 0.0894841775 * a - 1.291485548 * b
  const l = l2 ** 3
  const m = m2 ** 3
  const s = s2 ** 3
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  }
}

export const hexToOklch = (hex: string): Oklch => {
  const { b, g, r } = hexToRgb(hex)
  const lab = linearRgbToOklab({ r: toLinear(r), g: toLinear(g), b: toLinear(b) })
  const C = Math.sqrt(lab.a * lab.a + lab.b * lab.b)
  const h = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360
  return { C, h, L: lab.L }
}

const IN_GAMUT_EPSILON = 1e-6

const isInGamut = ({ b, g, r }: Rgb): boolean =>
  [r, g, b].every((c) => c >= -IN_GAMUT_EPSILON && c <= 1 + IN_GAMUT_EPSILON)

/**
 * OKLCH → hex. Out-of-gamut colours give up chroma in 0.005 steps and keep
 * their lightness and hue: a theme's greys must stay the lightness the
 * derivation solved for, or the contrast floors it guarantees stop holding.
 */
export const oklchToHex = ({ C, h, L }: Oklch): string => {
  const lightness = clamp01(L)
  const radians = (h * Math.PI) / 180
  for (let chroma = Math.max(0, C); chroma > 0; chroma -= 0.005) {
    const linear = oklabToLinearRgb({
      L: lightness,
      a: Math.cos(radians) * chroma,
      b: Math.sin(radians) * chroma,
    })
    if (isInGamut(linear)) {
      return rgbToHex({ r: toGamma(linear.r), g: toGamma(linear.g), b: toGamma(linear.b) })
    }
  }
  const grey = oklabToLinearRgb({ L: lightness, a: 0, b: 0 })
  return rgbToHex({ r: toGamma(grey.r), g: toGamma(grey.g), b: toGamma(grey.b) })
}

/** `set(L, C, h)` in the plan's derivation tables. */
export const set = (L: number, C: number, h: number): string => oklchToHex({ C, h, L })

const relativeLuminance = (hex: string): number => {
  const { b, g, r } = hexToRgb(hex)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/** WCAG 2.x contrast ratio, 1–21. */
export const contrastRatio = (a: string, b: string): number => {
  const ya = relativeLuminance(a)
  const yb = relativeLuminance(b)
  const lighter = Math.max(ya, yb)
  const darker = Math.min(ya, yb)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * `rgba(r,g,b,a)` over an opaque hex. Spelt without spaces so the generated
 * `[data-theme="organization"]` rule carries no whitespace at all.
 */
export const alpha = (hex: string, a: number): string => {
  const { b, g, r } = hexToRgb(hex)
  const channel = (value: number): number => Math.round(value * 255)
  return `rgba(${channel(r)},${channel(g)},${channel(b)},${a})`
}

/**
 * Step lightness until the candidate clears `floor` against every target.
 *
 * This is what makes §8.2's floors true by construction rather than by luck:
 * text is *solved* for its surfaces, so any seed that passed validation yields
 * readable text. Gives up after 40 steps and returns the last candidate — the
 * bands in §8.1 keep that from being reachable for a valid seed.
 */
export const solve = (
  startL: number,
  direction: 1 | -1,
  targets: readonly string[],
  floor: number,
  C: number,
  h: number,
): string => {
  let candidate = set(startL, C, h)
  for (let step = 0; step < 40; step += 1) {
    const worst = Math.min(...targets.map((target) => contrastRatio(candidate, target)))
    if (worst >= floor) return candidate
    const nextL = startL + direction * 0.02 * (step + 1)
    if (nextL <= 0 || nextL >= 1) return candidate
    candidate = set(nextL, C, h)
  }
  return candidate
}

/** The smaller of the two arcs between two hues, in degrees. */
export const hueDistance = (a: number, b: number): number => {
  const raw = Math.abs(((a - b) % 360) + 360) % 360
  return raw > 180 ? 360 - raw : raw
}
