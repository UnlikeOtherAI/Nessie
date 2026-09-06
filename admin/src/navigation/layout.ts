// The one layout decision for navigation: does the content region hold a
// single stack (phones, narrow web, an iPad in a narrow Split View), or a
// pinned list column beside detail stacks (tablet, desktop, large-phone
// landscape)? It is a pure function of the shell probes and the viewport
// bands, composed once (navigation/mobile-shell.ts `useNavigationLayout`); no page
// reads a breakpoint to decide its container, and `usePhoneLayout` survives
// only as `navigation === 'single'`.
//
// Rulebook: docs/navigation/overview.md §5.

export type NavigationLayout = 'single' | 'split'

export type NavigationLayoutInput = {
  // Below the `md` band (the viewport store's `!atLeast.md`).
  narrow: boolean
  // The native tablet lane: both dimensions at least 600 px.
  tabletMin: boolean
  reactNativeWebView: boolean
  // A Max-class iPhone reporting landscape: adjacent columns while it lasts.
  largePhoneLandscape: boolean
}

export const deriveNavigationLayout = ({
  narrow,
  tabletMin,
  reactNativeWebView,
  largePhoneLandscape,
}: NavigationLayoutInput): NavigationLayout => {
  if (reactNativeWebView) {
    // The native shell names its form factor; width alone never makes a
    // phone multi-column, and an iPad squeezed into a narrow Split View
    // drops to one stack.
    return tabletMin || largePhoneLandscape ? 'split' : 'single'
  }
  return narrow ? 'single' : 'split'
}
