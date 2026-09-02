// The registry's lookups: what screen a route renders, what a cold start
// seeds beneath it, what Back returns to and which section owns it. They
// read `surfaces.ts` and nothing else; the table stays in its own file so
// the totality lint's textual reads and the row declarations are one place.
// Rulebook: `docs/navigation.md` §1, §4, §5, §8.

import type { NavigationLayout } from './layout'
import type { SurfaceParent, SurfaceScreen } from './page-types'
import { CHANNELS_ROOT, matchSurface, normalizeNavigationPathname } from './surfaces'

// The screen a route renders, or null when it renders none: a redirect
// forwards without ever painting a stage, and an unknown path is not a
// screen at all (the gates make an unknown path impossible for a real route).
//
// The layout changes two things (docs/navigation.md §5). On `split` the
// section's list is the pinned column, not a screen, so a root and its
// details share the stack floor (depth 1): a root → detail is an in-place
// swap with nothing retained beneath, while a detail → nested still pushes
// inside the column. And a `splitInline` nested row classifies as its
// parent's screen there, because its parent's page renders it itself.
export const surfaceScreen = (
  pathname: string,
  layout: NavigationLayout = 'single',
): SurfaceScreen | null => {
  const matched = matchSurface(pathname)
  if (!matched || matched.surface.type === 'redirect') return null
  const { match, surface } = matched
  if (layout === 'split' && surface.splitInline && surface.parentOf) {
    return surfaceScreen(surface.parentOf(match).pathname, layout)
  }
  const depth = layout === 'split' ? Math.max(surface.depth, 1) : surface.depth
  if (!surface.identityOf || !surface.keyScope) {
    return {
      depth,
      key: `root:${surface.section}:${surface.root}`,
      section: surface.section,
    }
  }
  return {
    depth,
    key: `${surface.section}:${surface.keyScope(surface.identityOf(match))}`,
    section: surface.section,
  }
}

// The screens a cold start seeds beneath a route, nearest first
// (docs/navigation.md §8): the registry's parent chain up to the section
// root, with a `parent: 'origin'` row seeding only its section root (its real
// origin is unknowable on a cold link). On `split` the chain keeps only
// strictly shallower screens — a root shares the floor with its detail there
// and would be a swap, not a layer beneath. Roots seed nothing.
export const surfaceSeedChain = (
  pathname: string,
  layout: NavigationLayout = 'single',
): string[] => {
  const chain: string[] = []
  let screen = surfaceScreen(pathname, layout)
  let cursor = pathname
  const seen = new Set<string>([normalizeNavigationPathname(pathname)])
  while (screen) {
    const matched = matchSurface(cursor)
    if (!matched || matched.surface.type === 'root') break
    const next = matched.surface.parent === 'origin'
      ? matched.surface.root
      : matched.surface.parentOf?.(matched.match).pathname
    if (!next || seen.has(next)) break
    seen.add(next)
    const nextScreen = surfaceScreen(next, layout)
    if (!nextScreen) break
    if (nextScreen.depth < screen.depth) chain.push(next)
    screen = nextScreen
    cursor = next
  }
  return chain
}

// The deterministic parent screen of a route: what Back returns to on a cold
// deep link, and the label the Back control announces. Roots and redirects
// have none.
export const surfaceParent = (pathname: string): SurfaceParent | null => {
  const matched = matchSurface(pathname)
  if (!matched || matched.surface.type === 'redirect') return null
  return matched.surface.parentOf ? matched.surface.parentOf(matched.match) : null
}

// Which section (tab) owns a route. Unknown paths fall back to Channels, the
// first tab, so the tab bar always has one lit item.
export const surfaceRootPath = (pathname: string): string =>
  matchSurface(pathname)?.surface.root ?? CHANNELS_ROOT
