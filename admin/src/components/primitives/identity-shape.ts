/**
 * The one shape every identity picture in the admin takes: a rounded square
 * whose corner radius is proportional to the tile.
 *
 * It is a function rather than a `rounded-*` class because the radius tokens
 * (`--radius-sm|md|lg`) are re-declared on `:root` in styles.css, so Tailwind's
 * `rounded-md` resolves to a flat 10px at *every* size. The same class
 * therefore drew a 96px agent portrait as a near-square and an 18px sidebar
 * tile as a full circle — the inconsistency this module exists to remove.
 *
 * 0.28 is chosen so the most-seen size is unchanged: a 36px message avatar
 * keeps its 10px radius, while smaller tiles scale down with it.
 */
export const identityTileRadius = (size: number): number =>
  Math.max(3, Math.round(size * 0.28))

/** Radius of a ring/focus wrapper drawn immediately around a tile. */
export const identityRingRadius = (size: number, inset = 0): number =>
  identityTileRadius(size) + inset

/**
 * Initials for an identity, capped at two letters. `fallback` covers a name
 * made entirely of characters that yield nothing (emoji-only, whitespace).
 */
export const identityInitials = (value: string, fallback = 'N'): string =>
  value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('') || fallback
