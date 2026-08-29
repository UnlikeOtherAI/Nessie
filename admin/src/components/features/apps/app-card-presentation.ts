import type { AppSummaryRecord } from '@nessie/schemas'
import { APP_CATEGORY_LABELS } from '@nessie/schemas'

/**
 * Everything one card decides, as plain data.
 *
 * One card component renders every app — remote, first-party built-in, custom —
 * so the differences between them live here as status/action/pill values rather
 * than as a second card. Card copy is outcome-first by rule: "Connected",
 * "Reconnect", "3 accounts"; never "OAuth token expired" or "SSE unreachable".
 */

// ─── Links ──────────────────────────────────────────────────────────────────

export type AppLinkTarget = Pick<AppSummaryRecord, 'id' | 'slug'>

/**
 * The detail route prefers the slug because that URL is meant to be pasted to a
 * teammate and to survive a rename. An app with no slug assigned yet still has
 * to be reachable, so its id stands in.
 */
export const appDetailHref = (app: AppLinkTarget, tab?: string): string =>
  `/apps/${encodeURIComponent(app.slug ?? app.id)}${tab ? `?tab=${tab}` : ''}`

// Where connecting goes is `AppSummaryRecord.installHref`, named by the server.
// A client-side builder for the same URL used to sit here, which meant the card
// footer and the hero CTA each assembled their own destination and would part
// company the moment the connect phase changed it.

// ─── Icon fallback ──────────────────────────────────────────────────────────

/**
 * Initials for an app with no icon. A generic puzzle piece on every un-iconed
 * card makes a shelf of identical tiles; two letters at least stay distinct.
 */
export const appIconInitials = (displayName: string): string => {
  const words = displayName.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase()
  return `${(words[0] as string)[0]}${(words[1] as string)[0]}`.toUpperCase()
}

// ─── Footer status ──────────────────────────────────────────────────────────

export type AppCardStatusTone = 'accent' | 'danger' | 'muted' | 'success' | 'warning'

export type AppCardStatus =
  /** Available and healthy: absence of status is the signal. */
  | { kind: 'none' }
  /** A pill, for the states where a decision may be pending. */
  | { kind: 'pill'; label: string; tone: AppCardStatusTone }
  /** Quiet `--tx3` text — an uppercase tracked pill saying "Available" shouts. */
  | { kind: 'quiet'; label: string }

const pluralAccounts = (count: number): string =>
  `${count} ${count === 1 ? 'account' : 'accounts'}`

export const appCardStatus = (app: AppSummaryRecord): AppCardStatus => {
  // A built-in was never connected to anything, so "Connected" would be a
  // claim about a relationship that does not exist.
  if (app.distribution === 'builtin' && app.state === 'available') {
    return { kind: 'quiet', label: '● Always available' }
  }

  switch (app.state) {
    case 'available':
      return { kind: 'none' }
    case 'connecting':
      return { kind: 'pill', label: 'Connecting…', tone: 'accent' }
    case 'connected':
      return { kind: 'pill', label: '● Connected', tone: 'success' }
    case 'multiple_accounts':
      return {
        kind: 'pill',
        label: `● ${pluralAccounts(app.connectionCount)}`,
        tone: 'success',
      }
    case 'auth_expired':
      return { kind: 'pill', label: '⚠ Reconnect', tone: 'warning' }
    case 'error':
      return { kind: 'pill', label: '⚠ Connection error', tone: 'danger' }
    // Every account switched off — the same dot vocabulary as "connected",
    // hollow, because this is the same relationship in its off position and
    // not an availability verdict.
    case 'paused':
      return { kind: 'pill', label: '○ Turned off', tone: 'muted' }
    case 'disabled':
      return { kind: 'quiet', label: 'Unavailable' }
    case 'unavailable':
      return { kind: 'quiet', label: 'Not available right now' }
  }
}

// ─── Footer action ──────────────────────────────────────────────────────────

export type AppCardActionTone = 'primary' | 'secondary'

/** Where the decision behind a refusal actually lives, when a page owns it. */
export type AppUnavailableLink = { href: string; label: string }

export type AppCardAction =
  /** Nothing a person can do from a card — the detail view says why in words. */
  | { kind: 'none' }
  | { kind: 'link'; href: string; label: string; tone: AppCardActionTone }
  /** `title` is a tooltip, so it stays a complete sentence with no link in it. */
  | { kind: 'disabled'; label: string; title: string; tone: AppCardActionTone }

export type AppUnavailableExplanation = {
  text: string
  /** Where the decision lives, for surfaces with room to render an anchor. */
  link: AppUnavailableLink | null
}

/**
 * Why this app cannot be connected here, in one sentence that always names
 * either what the person can do or who can change it.
 *
 * The first two cases keep the button visible and disabled rather than hiding
 * it: a missing button reads as a missing feature, a disabled one with a reason
 * reads as somebody else's call. Naming Integrations is not enough on its own —
 * a member then has to go and find it — so that one carries the door as well as
 * the sentence.
 *
 * The three verdicts below — blocked, retired, unreachable — belong to the
 * states with no button at all, and all three used to return null. The detail
 * hero builds its explanation from exactly this function, so the surface whose
 * whole job is to explain rendered a bare "Unavailable" and stopped. Which
 * verdict it is stays legible from the wire: `trustLevel` carries the
 * moderation block, and `state` separates a retired app from one whose server
 * could not be reached, so no new field is needed to say it.
 */
export const appUnavailableExplanation = (
  app: AppSummaryRecord,
): AppUnavailableExplanation | null => {
  if (app.managedByIntegration) {
    return {
      text: 'Turned on from Integrations, not here.',
      link: { href: '/settings/integrations', label: 'Open Integrations' },
    }
  }
  if (app.locked) return { text: 'Managed by your admin.', link: null }

  // Gated on the two action-less states rather than on the underlying flags, so
  // a verdict can never be worded over an app that is connected and working.
  if (app.state === 'disabled') {
    return app.trustLevel === 'blocked'
      ? {
        text: 'Blocked for this organisation, so it cannot be connected. An owner can lift that.',
        link: null,
      }
      : {
        text: 'No longer offered by its publisher, so new accounts cannot be connected. '
          + 'An owner can point you at a replacement.',
        link: null,
      }
  }
  if (app.state === 'unavailable') {
    return {
      text: "Nessie could not reach this app's server when it last checked. Try again shortly; "
        + 'if it keeps failing, an owner can look into it.',
      link: null,
    }
  }
  return null
}

export const appCardAction = (app: AppSummaryRecord): AppCardAction => {
  // "Open", never "Connect": there is no account to connect, only a surface to
  // visit, and the detail page is that surface.
  if (app.distribution === 'builtin' && app.state === 'available') {
    return { kind: 'link', href: appDetailHref(app), label: 'Open', tone: 'secondary' }
  }

  const blocked = appUnavailableExplanation(app)
  const connect = (label: string): AppCardAction =>
    blocked === null
      ? { kind: 'link', href: app.installHref, label, tone: 'primary' }
      : { kind: 'disabled', label, title: blocked.text, tone: 'primary' }

  switch (app.state) {
    case 'available':
      return connect('Connect')
    case 'connecting':
      // Not "Finishing the connection" — an install waiting on a key nobody
      // has entered is in this state indefinitely, and the card must not
      // promise it is about to resolve itself. Opening the app is the way on.
      return {
        kind: 'disabled',
        label: 'Connecting…',
        title: 'This connection has not finished setting up yet.',
        tone: 'primary',
      }
    case 'connected':
    case 'multiple_accounts':
      return {
        kind: 'link',
        href: appDetailHref(app, 'accounts'),
        label: 'Manage',
        tone: 'secondary',
      }
    // `paused` still belongs in the connected family — the accounts exist, and
    // the tab names each one and offers connecting a fresh account, which is
    // the way back to a working app. It says "View accounts" rather than
    // "Manage" because nothing in the product switches a paused install back
    // on: there is no such endpoint, and the accounts list renders name,
    // status and error with no control. "Manage" sent the one person who cares
    // to a page that read "Turned off" back at them.
    case 'paused':
      return {
        kind: 'link',
        href: appDetailHref(app, 'accounts'),
        label: 'View accounts',
        tone: 'secondary',
      }
    case 'auth_expired':
      return connect('Reconnect')
    case 'error':
      return connect('Retry')
    case 'disabled':
    case 'unavailable':
      return { kind: 'none' }
  }
}

// Every card opens, in every state. `connecting` used to be the exception, on
// the assumption it lasts seconds — but it is `lifecycleState: 'pending_setup'`,
// which every install starts in and only a passing Test leaves. One waiting on
// an API key, or on an OAuth flow nobody finished, sits there indefinitely, and
// a card that neither opens nor offers a control is a dead end in the
// catalogue. The detail page is where such a connection is diagnosed and
// re-driven, so it has to stay one click away.

// ─── Attribute pills ────────────────────────────────────────────────────────

export type AppKindPillTone = 'accent' | 'info' | 'neutral'

export type AppKindPill = { label: string; tone: AppKindPillTone }

/**
 * At most one attribute pill beside the category, in a fixed priority, because
 * two pills plus a status pill turns a card into a legend. `package`
 * distribution earns none: how an app is delivered is not a fact a person
 * browsing a shelf acts on.
 */
export const appKindPill = (app: AppSummaryRecord): AppKindPill | null => {
  if (app.featured) return { label: 'Featured', tone: 'accent' }
  if (app.distribution === 'builtin') return { label: 'Built-in', tone: 'neutral' }
  if (app.distribution === 'remote') return { label: 'Remote', tone: 'info' }
  return null
}

export const appCategoryLabel = (app: AppSummaryRecord): string =>
  APP_CATEGORY_LABELS[app.primaryCategory]

// ─── Meta line ──────────────────────────────────────────────────────────────

/**
 * One fact under the description, never two. A capability count answers "what
 * do I get?"; until the app has been probed there is no count, and the
 * publisher's name is the next most useful thing to know.
 */
export const appCardMeta = (app: AppSummaryRecord): string | null => {
  if (app.toolCount !== null) {
    return `${app.toolCount} ${app.toolCount === 1 ? 'capability' : 'capabilities'}`
  }
  return app.vendor ? `By ${app.vendor}` : null
}

/** Stable per-app hook for the end-to-end tests; the slug when there is one. */
export const appCardTestId = (app: AppLinkTarget): string => `app-card-${app.slug ?? app.id}`
