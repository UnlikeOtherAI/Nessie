/**
 * The native chrome's copy of the admin's identity-tile shape contract
 * (`admin/src/components/primitives/identity-shape.ts`). The two must agree:
 * the native header sits directly above the WebView that renders the same
 * person and the same team, so a different radius here reads as two
 * different apps stacked on top of each other.
 *
 * It is duplicated rather than imported because the Expo app does not build
 * against the admin bundle; `admin/test/native-touch-navigation.test.ts` asserts
 * the two stay identical.
 */
export const identityTileRadius = (size: number): number =>
  Math.max(3, Math.round(size * 0.28))

/** Up to two initials, matching the web fallback for the same name. */
export const identityInitials = (value: string | null | undefined, fallback: string): string =>
  (value ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('') || fallback
