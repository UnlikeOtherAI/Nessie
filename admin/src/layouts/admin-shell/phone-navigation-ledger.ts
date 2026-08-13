import {
  getPhoneTabRootPath,
  resolvePhoneNavigationBackAction,
  type PhoneNavigationBackAction,
} from './phone-navigation'

// The app's own same-document history ledger. React Router's browser history
// cannot be introspected safely (Navigator.entries is an unstable private
// shape), so the shell keeps the session's (key, path) trail itself — as real
// ledger state: the entries AND the index of the entry the user stands on.
// Entries store the full path (pathname + search + hash) so a pop can land on
// the exact location; semantic-parent and tab-root comparisons normalize to
// the pathname in phone-navigation. A POP moves the index (backward or
// forward to a known key), a PUSH after a Back truncates the abandoned
// forward entries before appending, a REPLACE rewrites the entry at the
// current index, and re-notifying the same location event is a no-op.
export type PhoneHistoryEntry = {
  key: string
  path: string
}

export type PhoneHistoryAction = 'PUSH' | 'REPLACE' | 'POP'

export type PhoneHistoryLedger = {
  entries: PhoneHistoryEntry[]
  // Index into `entries` of the current location. Entries after it are
  // forward history; the entry before it is where browser Back would land.
  index: number
}

export const createPhoneHistoryLedger = (
  key: string,
  path: string,
): PhoneHistoryLedger => ({ entries: [{ key, path }], index: 0 })

export const recordPhoneHistory = (
  ledger: PhoneHistoryLedger,
  action: PhoneHistoryAction,
  key: string,
  path: string,
): PhoneHistoryLedger => {
  const { entries, index } = ledger
  const current = entries[index]

  if (action === 'POP') {
    const knownIndex = entries.findIndex((entry) => entry.key === key)
    if (knownIndex !== -1) {
      // Backward or forward to a known location: move the index only. Forward
      // entries stay intact so a later Forward still resolves.
      return knownIndex === index ? ledger : { entries, index: knownIndex }
    }
    if (current?.key === key && current.path === path) {
      // The same location event re-notified (StrictMode, a re-render after an
      // async boundary): idempotent no-op, never a duplicate append.
      return ledger
    }
    // An unknown POP target (a restored session, or an entry recorded before
    // the ledger existed) cannot be keyed onto the trail, so it must not
    // inherit adjacency: splicing it in behind the old current entry would
    // fabricate a Back predecessor that never existed. Reset to a safe
    // single-entry ledger whose Back decision falls to the route metadata.
    return { entries: [{ key, path }], index: 0 }
  }

  if (action === 'REPLACE') {
    // Same-document replacement with an unchanged key is a duplicate
    // notification, not a new entry.
    if (current?.key === key && current.path === path) return ledger
    if (entries.length === 0 || !current) {
      return { entries: [{ key, path }], index: 0 }
    }
    const next = entries.slice()
    next[index] = { key, path }
    return { entries: next, index }
  }

  // PUSH.
  if (current?.key === key) {
    // A repeated notification for the current entry is a no-op. A repeated
    // notification with a *different* path under the same key is a
    // same-document URL state update (React Router's default key is
    // "default"): fold it into the current entry rather than stacking a
    // phantom duplicate Back would land on.
    if (current.path === path) return ledger
    const next = entries.slice()
    next[index] = { key, path }
    return { entries: next, index }
  }
  // Every real PUSH mints a fresh key — including same-document URL-state
  // updates (React Router assigns one per history entry) — so Back can unwind
  // them entry by entry. The key, never the path, decides duplication.
  const next = entries.slice(0, index + 1)
  next.push({ key, path })
  return { entries: next, index: next.length - 1 }
}

export const currentPhoneHistoryEntry = (
  ledger: PhoneHistoryLedger,
): PhoneHistoryEntry | null => ledger.entries[ledger.index] ?? null

export const previousPhoneHistoryPath = (
  ledger: PhoneHistoryLedger,
): string | null => ledger.entries[ledger.index - 1]?.path ?? null

// Route-level Back: pop only when the entry behind the current one is the
// semantic parent; otherwise replace the current entry with the deterministic
// parent. A cold deep link has no in-app history to unwind, and replacing it
// (rather than pushing above it) means a later browser Back from the parent
// leaves the app instead of looping back onto the detail. Both sides are
// normalized pathnames: the ledger stores full pathname+search+hash, while
// semantic parents compare pathnames only.
export const resolvePhoneLedgerBackAction = (
  ledger: PhoneHistoryLedger,
): PhoneNavigationBackAction => {
  const current = currentPhoneHistoryEntry(ledger)
  if (!current) return null
  return resolvePhoneNavigationBackAction(
    pathnameOf(current.path),
    previousPhoneHistoryPathname(ledger),
  )
}

export const previousPhoneHistoryPathname = (
  ledger: PhoneHistoryLedger,
): string | null => {
  const previous = previousPhoneHistoryPath(ledger)
  return previous === null ? null : pathnameOf(previous)
}

// Reselecting the active tab must never push a duplicate. At the root it is a
// no-op. At a detail it returns to the tab root — popping when the root is
// the entry immediately behind, otherwise replacing so the detail does not
// linger beneath the root (which would let Back return to the detail and
// loop). Comparisons run on normalized pathnames: a root carrying query state
// is still the root.
export type PhoneTabAction =
  | { type: 'none' }
  | { type: 'pop' }
  | { type: 'replace'; root: string }
  | { type: 'push'; root: string }

// The semantic pathname of a stored full path: strip query/hash and trailing
// slashes. `/channels?filter=unread` and `/channels` are the same tab root
// even though their stored full paths differ.
export const pathnameOf = (path: string): string => {
  const normalized = (path.split(/[?#]/, 1)[0] ?? '').replace(/\/+$/, '')
  return normalized || '/'
}

const isSameNormalizedPath = (a: string, b: string): boolean =>
  pathnameOf(a) === pathnameOf(b)

export const resolvePhoneTabPress = (
  ledger: PhoneHistoryLedger,
): PhoneTabAction => {
  const current = currentPhoneHistoryEntry(ledger)
  if (!current) return { type: 'none' }
  const root = getPhoneTabRootPath(current.path)
  if (isSameNormalizedPath(current.path, root)) return { type: 'none' }
  const previous = previousPhoneHistoryPath(ledger)
  if (previous && isSameNormalizedPath(previous, root)) return { type: 'pop' }
  return { type: 'replace', root }
}

// A tap on a tab drives its root. Reselecting the active tab follows
// resolvePhoneTabPress; switching tabs pushes the new root — replace only
// when the current entry already is that root, so a restored location cannot
// stack a duplicate of itself.
export const resolvePhoneTabSelect = (
  ledger: PhoneHistoryLedger,
  tabRoot: string,
): PhoneTabAction => {
  const current = currentPhoneHistoryEntry(ledger)
  if (!current) return { type: 'push', root: tabRoot }
  if (getPhoneTabRootPath(current.path) === tabRoot) {
    return resolvePhoneTabPress(ledger)
  }
  if (isSameNormalizedPath(current.path, tabRoot)) return { type: 'replace', root: tabRoot }
  return { type: 'push', root: tabRoot }
}
