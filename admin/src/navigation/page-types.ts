// The page-type vocabulary (`docs/navigation/overview.md` §1, plan §3): the closed set
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

// The params a route reads beyond its path (`docs/navigation/overview.md` §8). A name
// under `consume` is a one-shot instruction carried in the search string
// (highlight this message, open this connect dialog); `hash` is the same in
// the fragment (`#trigger-<id>`). Both are read only through
// `navigation/intent.ts`, which captures the value and strips it with one
// replacing redirect. A name under `state` is linkable and stays in the URL
// — a tab, a filter, a query — and reads through `useTabParam` or
// `useSearchParams`. The gate (`admin/test/navigation-intent.test.ts`)
// refuses a consumed name read anywhere else, or one no row declares.
export type SurfaceIntent = {
  consume?: readonly string[]
  hash?: readonly string[]
  state?: readonly string[]
}

export type Surface = {
  // Does this section's root render the section's contextual list (the
  // channels/projects/knowledge/admin sidebars) as its page? Search renders
  // its outlet instead. Only meaningful on a `root` row.
  contextualList?: boolean
  // Numeric depth inside the section's stack. Roots are 0; each push deeper
  // is one more. Direction (push vs pop) is decided from depth alone.
  depth: number
  // Folds same-screen siblings onto one identity: a channel's whole info
  // chain, a project's tab routes, a designer's edit targets.
  identityOf?: (match: RegExpMatchArray) => string
  // The intent params this route reads; absent when it reads none.
  intent?: SurfaceIntent
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
  // A nested screen that a split layout renders inside its parent's own page
  // (the conversation's info chain and reply thread, a status's detail
  // beside the status list). On `split` it classifies as its parent's
  // screen, so the stack neither pushes nor animates; on `single` it is the
  // pushed screen it declares. Only meaningful on a `nested` row.
  splitInline?: true
  // A surface that fills the viewport and owns its own inner scroller (the
  // chat conversation: a fixed header/composer with a scrolling feed between
  // them), rather than being page-height content the phone page shell scrolls.
  // On `single`, the shell (`.phone-navigation-page`) is a block scroller, so
  // a `flex-1`/`h-full` full-height child inside it has no bounded height to
  // fill and collapses to content height — which floats the composer up under
  // the last message with a gap below. This flag switches that one screen's
  // shell to a non-scrolling flex column so the surface fills it and its
  // composer stays pinned to the bottom. Only meaningful on `single`; `split`
  // already bounds the detail column. See
  // `docs/navigation/page-types-and-motion.md` §2.
  fillsViewport?: true
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
