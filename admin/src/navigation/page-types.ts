// The page-type vocabulary (`docs/navigation.md` §1, plan §3): the closed set
// of what a screen can be, and the shape of the row that declares it. The
// registry (`surfaces.ts`) fills this in for every route; step 6's nested
// stages register against the same vocabulary, which is why it lives beside
// the table rather than inside it.

// The five top-level sections. A section is a stack: its root is depth 0 and
// every screen inside it is deeper.
export type SurfaceSection = 'admin' | 'channels' | 'knowledge' | 'projects' | 'search'

// The closed set of page types. Overlays are not routes, so they are not
// here — they are painted over whatever screen a row owns. `redirect` is not
// a page type either: it marks a route that only forwards to another one, so
// it never classifies a screen (see `surfaceScreen`), but it still declares
// which section owns the moment it is on screen.
export type SurfaceType = 'root' | 'detail' | 'nested' | 'tabHost' | 'flow' | 'redirect'

export type SurfaceParent = {
  label: string
  pathname: string
}

// A Flow is a full screen on a single-column layout and a centred panel on a
// split one. Every flow that exists today is a full page, so `screen` is the
// only value in use; the field exists so the split layout (step 5) reads a
// declaration rather than a heuristic.
export type SurfaceFlowPresentation = 'panel' | 'screen'

export type Surface = {
  // Does this section's root render the section's contextual list (the
  // channels/projects/knowledge/admin sidebars) as its page? Search renders
  // its outlet instead. Only meaningful on a `root` row.
  contextualList?: boolean
  // Numeric depth inside the section's stack. Roots are 0; each push deeper
  // is one more. Direction (push vs pop) is decided from depth alone.
  depth: number
  flowPresentation?: SurfaceFlowPresentation
  // Folds same-screen siblings onto one identity: a channel's whole info
  // chain, a project's tab routes, a designer's edit targets.
  identityOf?: (match: RegExpMatchArray) => string
  // Scopes that identity to a mounted screen. Where one page swaps its
  // content in place (channel A → B, space A → B), every sibling shares one
  // scope so the swap is not a route transition.
  keyScope?: (identity: string) => string
  // A screen reachable from every section (the bell, the account menu, a
  // push notification). Back returns to wherever the reader came from when
  // the ledger knows, and falls back to `parentOf` on a cold deep link.
  parent?: 'origin'
  // The deterministic parent screen. Absent on roots and redirects.
  parentOf?: (match: RegExpMatchArray) => SurfaceParent
  pattern: RegExp
  // The section's root path — the tab this route belongs to.
  root: string
  section: SurfaceSection
  type: SurfaceType
}

export type SurfaceScreen = {
  depth: number
  key: string
  section: SurfaceSection
}
