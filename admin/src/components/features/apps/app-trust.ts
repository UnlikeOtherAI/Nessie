import type { AppTrustLevel } from '@nessie/schemas'

/**
 * How much the instance vouches for an app, said in one chip.
 *
 * The chip is the same size and wording on the card and in the detail hero, so
 * clicking through never changes the story a person was told about who
 * published this thing.
 */

/**
 * Icon identity, not an icon: this module stays free of React and of the icon
 * library so the trust mapping can be asserted directly. `AppTrustBadge` owns
 * the glyph each id resolves to.
 */
export type AppTrustIconId = 'shield' | 'verified' | 'community' | 'unknown' | 'blocked'

export type AppTrustBadgeModel = {
  iconId: AppTrustIconId
  label: string
  /** What the chip means, as a `title`, because the label alone is a word. */
  description: string
  toneClass: string
}

const TRUST_BADGES: Record<AppTrustLevel, AppTrustBadgeModel> = {
  nessie: {
    iconId: 'shield',
    label: 'Nessie',
    description: 'Built and reviewed by Nessie.',
    // `--thinking` rather than `--accent-strong`: the strong accent is a dark
    // purple that disappears into the panel on every dark theme, while
    // `--thinking` is the accent-family foreground each theme already tuned to
    // sit on `--accent-soft` (see Pill's accent tone).
    toneClass: 'bg-[color:var(--accent-soft)] text-[color:var(--thinking)]',
  },
  verified: {
    iconId: 'verified',
    label: 'Verified',
    description: 'Reviewed by Nessie and confirmed with its publisher.',
    toneClass: 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]',
  },
  community: {
    iconId: 'community',
    label: 'Community',
    description: 'Published by a community member and not reviewed by Nessie.',
    toneClass: 'bg-[color:var(--warning-soft)] text-[color:var(--warning-text)]',
  },
  unknown: {
    iconId: 'unknown',
    label: 'Unknown',
    description: 'Added by address, so nothing is known about who publishes it.',
    toneClass: 'bg-[color:var(--overlay)] text-[color:var(--tx2)]',
  },
  blocked: {
    iconId: 'blocked',
    label: 'Blocked',
    description: 'Turned off for this organisation.',
    toneClass: 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
  },
}

export const appTrustBadge = (trustLevel: AppTrustLevel): AppTrustBadgeModel =>
  TRUST_BADGES[trustLevel]

/**
 * A card carries at most two chips before it stops reading as a shelf item, so
 * the card spends one of them only on provenance a person can act on. "Unknown"
 * is the default for anything added by address — printing it on every custom
 * app would be noise on the surface where the noise costs most. The detail hero
 * still states it, because that is where the decision to connect is made.
 */
export const showsTrustBadgeOnCard = (trustLevel: AppTrustLevel): boolean =>
  trustLevel !== 'unknown'
