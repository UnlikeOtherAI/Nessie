import type { AppDetailRecord } from '@nessie/schemas'
import {
  appCardAction,
  appCategoryLabel,
  type AppCardAction,
  type AppCardActionTone,
} from './app-card-presentation'
import type { ConnectPhase } from './connect-flow'

/**
 * What the app detail page shows and in which tab.
 *
 * The page is the member surface: connect, accounts, capabilities, and agents.
 * Health probes, failure counts, endpoints, and credentials are operational
 * facts that do not render here.
 */

// ─── Tabs ───────────────────────────────────────────────────────────────────

export type AppDetailTab = 'overview' | 'capabilities' | 'accounts' | 'agents'

export const APP_DETAIL_TAB_LABELS: Record<AppDetailTab, string> = {
  overview: 'Overview',
  capabilities: 'Capabilities',
  accounts: 'Connected accounts',
  agents: 'Agents with access',
}

export type AppDetailTabModel = {
  /** Rendered in parentheses; null keeps the label alone rather than "(0)". */
  count: number | null
  id: AppDetailTab
  label: string
}

export const appIsConnected = (app: AppDetailRecord): boolean => app.connections.length > 0

/**
 * Removing an app disconnects every account this detail view exposes. It is
 * only a coherent action when the caller can manage every one of them; showing
 * it for a shared account they cannot remove would promise an outcome the
 * server correctly refuses.
 */
export const appCanBeRemoved = (app: AppDetailRecord): boolean =>
  app.connections.length > 0 && app.connections.every((connection) => connection.canDisconnect)

/**
 * The number of things this app can do. The probed list is the truth once it
 * exists; the stored count covers the window before an app has been probed.
 */
export const appCapabilityCount = (app: AppDetailRecord): number | null =>
  app.capabilities.tools.length > 0 ? app.capabilities.tools.length : app.toolCount

/**
 * "Connected accounts" appears only once there is one. Before connecting, an
 * empty tab teaches a person that the app has no accounts — which they already
 * know, having not connected it.
 */
export const appDetailTabs = (app: AppDetailRecord): AppDetailTabModel[] => {
  const tabs: AppDetailTabModel[] = [
    { count: null, id: 'overview', label: APP_DETAIL_TAB_LABELS.overview },
    {
      count: appCapabilityCount(app),
      id: 'capabilities',
      label: APP_DETAIL_TAB_LABELS.capabilities,
    },
  ]
  if (appIsConnected(app)) {
    tabs.push({
      count: app.connections.length,
      id: 'accounts',
      label: APP_DETAIL_TAB_LABELS.accounts,
    })
  }
  tabs.push({
    count: app.agentsWithAccess.length > 0 ? app.agentsWithAccess.length : null,
    id: 'agents',
    label: APP_DETAIL_TAB_LABELS.agents,
  })
  return tabs
}

/**
 * `?tab=` is deep-linkable, so it arrives from anywhere — an old bookmark, a
 * link pasted before the app was disconnected. A tab that is not on offer falls
 * back to Overview rather than rendering a blank panel.
 */
export const resolveAppDetailTab = (
  raw: string | null,
  tabs: readonly AppDetailTabModel[],
): AppDetailTab =>
  tabs.find((tab) => tab.id === raw)?.id ?? 'overview'

// ─── Hero ───────────────────────────────────────────────────────────────────

/** The card's action vocabulary, plus the one thing only this page can do. */
export type AppDetailCta =
  | AppCardAction
  /** Runs the connect flow on this page; never navigates. */
  | { kind: 'connect'; label: string; tone: AppCardActionTone }

/**
 * The hero's primary control.
 *
 * It is the card's decision — the same eight states resolve to the same action,
 * and the label stays the card's one word, because a person standing on
 * GitHub's page under GitHub's name and icon does not need "Connect Nessie to
 * GitHub" spelled out. The card and the detail hero now offer the SAME action:
 * both run the connect flow in place (`kind: 'connect'`), because connecting
 * from the store must never bounce a person away from their app. So this is
 * a pass-through — kept as a named seam because the hero has diverged from the
 * card before and may again, and one call site is cheaper to change than every
 * consumer.
 */
export const appDetailCta = (app: AppDetailRecord): AppDetailCta => appCardAction(app)

/**
 * Whether the connect flow currently owns the outcome, which is what spends the
 * CTA: pressing Connect twice would start a second handshake over the first.
 * The settled phases are not in flight — an error and a missing key each carry
 * their own control in the panel below, and a finished connect has already
 * flipped the hero.
 */
export const appConnectInFlight = (phase: ConnectPhase): boolean =>
  phase === 'probing' || phase === 'awaiting_authorization' || phase === 'verifying'

/** "by GitHub, Inc. · Development", or just the category when nobody claims it. */
export const appProviderLine = (app: AppDetailRecord): string => {
  const category = appCategoryLabel(app)
  return app.vendor ? `by ${app.vendor} · ${category}` : category
}

/** The line under the CTA: what you get, in the store's own vocabulary. */
export const appHeroMeta = (app: AppDetailRecord): string | null => {
  const capabilities = appCapabilityCount(app)
  if (capabilities === null) return null
  return `${capabilities} ${capabilities === 1 ? 'capability' : 'capabilities'}`
}

// ─── Overview ───────────────────────────────────────────────────────────────

export type AppDetailStat = { label: string; value: string }

/**
 * "What did I get?" — the only telemetry a member needs. A tile with nothing to
 * report is cut rather than shown as zero: failure counts and health probes are
 * owner-ops data.
 */
export const appDetailStats = (app: AppDetailRecord): AppDetailStat[] => {
  const stats: AppDetailStat[] = []
  const capabilities = appCapabilityCount(app)
  if (capabilities !== null) {
    stats.push({ label: 'Capabilities', value: String(capabilities) })
  }
  if (app.resourceCount !== null) {
    stats.push({ label: 'Resources', value: String(app.resourceCount) })
  }
  if (app.promptCount !== null) {
    stats.push({ label: 'Prompts', value: String(app.promptCount) })
  }
  if (app.connections.length > 0) {
    stats.push({ label: 'Accounts', value: String(app.connections.length) })
  }
  return stats
}

export type AppDetailLink = { href: string; label: string }

export const appDetailLinks = (app: AppDetailRecord): AppDetailLink[] =>
  [
    { href: app.websiteUrl, label: 'Website' },
    { href: app.documentationUrl, label: 'Documentation' },
    { href: app.repositoryUrl, label: 'Source code' },
  ].flatMap((entry) => (entry.href ? [{ href: entry.href, label: entry.label }] : []))

// ─── Empty and absent states ────────────────────────────────────────────────

export type AppEmptyMessage = { body: string; title: string }

/**
 * "Why can't my agent see this tool?" is the support question this page exists
 * to pre-answer, and the answer differs by one fact: whether the app is
 * connected at all.
 */
export const agentsAccessEmptyMessage = (app: AppDetailRecord): AppEmptyMessage =>
  appIsConnected(app)
    ? {
      body:
          'This app is connected, but no agent has permission to use it. '
          + 'Give an agent access and it can call these capabilities.',
      title: 'No agents can use this yet',
    }
    : {
      body: 'Connect the app first, then choose which agents may use it.',
      title: 'No agents can use this yet',
    }

/**
 * The capability list renders before connecting too — "is this worth
 * connecting?" is answered by what it can do — so the note says which of the
 * two lists a person is looking at.
 */
export const capabilitiesNote = (app: AppDetailRecord): string | null => {
  if (app.capabilities.tools.length === 0) {
    return "This app hasn't said what it can do yet. Connect it to find out."
  }
  return appIsConnected(app) ? null : 'Connect to enable these for your agents.'
}

export const connectionsEmptyMessage: AppEmptyMessage = {
  body: 'Connecting an account lets Nessie reach this app on your behalf.',
  title: 'No accounts connected yet',
}

export const appNotFoundMessage = (isPending: boolean): string =>
  isPending ? 'Loading app…' : 'This app could not be found.'
