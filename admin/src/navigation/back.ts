import type { LocalBackSnapshot } from '../layouts/admin-shell/local-back/local-back-registry'
import {
  type PhoneHistoryLedger,
  resolvePhoneLedgerBackAction,
} from '../layouts/admin-shell/phone-navigation-ledger'
import { getPhoneNavigationBackTarget } from '../layouts/admin-shell/phone-navigation'

// The one Back decision. Every entry point — the header button, the edge
// swipe, Android hardware Back, Escape, a browser POP landing on a parent —
// asks this function and performs what it returns. Order: the topmost
// registered owner (an open overlay, the deepest nested stage) → the route's
// parent, popping real history when the ledger's previous entry is that
// parent and replacing otherwise → nothing (a root: the menu doorway).
//
// The desktop top bar and the iPad toolbar are history controls, not Back:
// they walk the ledger across sections (see history.ts) and only consult the
// registry first so a toolbar Back never pops a route underneath an open
// owner. Rulebook: docs/navigation/overview.md §4.

export type BackAction =
  | {
      kind: 'owner'
      id: string
      label: string
      perform: () => void
      // Whether the edge swipe may drive this owner closed. Owners that must
      // not be dismissed by a gesture (an editor mid-flush) register with
      // swipeable: false; everything else is swipeable.
      swipeable: boolean
    }
  | {
      kind: 'route'
      label: string
      mode: 'pop' | 'replace'
      to: string
      swipeable: true
    }

export type ResolveBackInput = {
  // The current location's pathname (semantic, no query).
  pathname: string
  // The registry's live snapshot, or null outside the shell.
  owners: LocalBackSnapshot | null
  // The ledger, or null when the caller has no history (metadata-only Back).
  ledger: PhoneHistoryLedger | null
}

export const resolveBack = ({ pathname, owners, ledger }: ResolveBackInput): BackAction | null => {
  const owner = owners?.active ?? null
  if (owner) {
    return {
      kind: 'owner',
      id: owner.id,
      label: owner.label,
      perform: owner.onBack,
      swipeable: owner.swipeable ?? true,
    }
  }

  const target = getPhoneNavigationBackTarget(pathname)
  if (!target) return null

  const action = ledger ? resolvePhoneLedgerBackAction(ledger) : null
  // A pop to somewhere other than the declared parent — an origin screen's
  // real predecessor, the section a push came from — has no registry label,
  // so the control says only "Back" rather than naming a screen it will not
  // go to.
  const toOrigin = action?.mode === 'pop' && action.to !== target.pathname
  return {
    kind: 'route',
    label: toOrigin ? 'Back' : target.label,
    mode: action?.mode ?? 'replace',
    to: action?.to ?? target.pathname,
    swipeable: true,
  }
}

// True when Back has somewhere to go — what the native bridge reports as
// `hasBackDepth` and what arms the edge swipe.
export const hasBackAction = (input: ResolveBackInput): boolean => resolveBack(input) !== null
