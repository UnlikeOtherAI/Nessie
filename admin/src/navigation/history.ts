import { activeNavSection, type NavSectionId } from '../layouts/admin-shell/nav-items'
import {
  type PhoneHistoryLedger,
  pathnameOf,
} from '../layouts/admin-shell/phone-navigation-ledger'

// Reads on the one history ledger that the top bar, the iPad toolbar and the
// rail used to keep for themselves. The ledger (phone-navigation-ledger.ts)
// records every PUSH / REPLACE / POP the router commits; these helpers derive
// what those surfaces need from it instead of counting on their own.
//
// Rulebook: docs/navigation/overview.md §4.

export const canGoBack = (ledger: PhoneHistoryLedger): boolean => ledger.index > 0

export const canGoForward = (ledger: PhoneHistoryLedger): boolean =>
  ledger.index < ledger.entries.length - 1

// Where the reader last stood inside a section, searching the ledger from the
// current entry backwards. The desktop rail sends a section's tab to that
// place instead of the section root, so switching tabs feels like the tab was
// never left. Session-scoped by construction: the ledger starts at the
// current location on every full load.
export const lastPathInSection = (
  ledger: PhoneHistoryLedger,
  section: NavSectionId,
): string | null => {
  for (let index = ledger.index; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (!entry) continue
    if (activeNavSection(pathnameOf(entry.path)) === section) return entry.path
  }
  return null
}

// The navigation target for a section's tab button: the remembered place if
// the reader has been there this session, else the section's canonical root.
export const resolveSectionTarget = (
  ledger: PhoneHistoryLedger,
  section: NavSectionId,
  root: string,
): string => lastPathInSection(ledger, section) ?? root
