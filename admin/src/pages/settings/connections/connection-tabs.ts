import { CommsProviderSchema } from '@nessie/schemas'

import type { CommsProvider } from '../../../lib/api-client'

/**
 * Connected accounts' tabs, grouped by what an account is for rather than by
 * how it connects.
 *
 * A Google account's mail and calendar capabilities are one row on Mail and
 * calendar, whichever of that tab's two connect actions made it — before, a
 * calendar-only connection was started on a Calendar tab and then listed under
 * Email. Slack is Chat, a project's board accounts are Tickets and code, the
 * cloud browser is Browsers, and the plans and local models the agents you own
 * run on are AI plans.
 */
export const CONNECTION_TABS = ['mail', 'chat', 'tickets', 'browsers', 'ai'] as const
export type ConnectionTab = (typeof CONNECTION_TABS)[number]

/** The tab the bare address opens on; selecting it drops `?tab=` (`useTabParam`). */
export const DEFAULT_CONNECTION_TAB: ConnectionTab = 'mail'

/**
 * Each tab's label and the header's one-sentence description of what a person
 * does there. No protocol names: how an account connects is the connect
 * dialog's business, not the page's.
 */
export const CONNECTION_TAB_META: Record<ConnectionTab, { description: string; label: string }> = {
  ai: {
    description:
      'Link an AI plan you already pay for, or a model on your own computer, for the agents you '
      + 'own to run on.',
    label: 'AI plans',
  },
  browsers: {
    description:
      'Connect the cloud browser your agents use for the runs you start, and see the sites you '
      + 'signed them into.',
    label: 'Browsers',
  },
  chat: {
    description: 'Connect Slack separately from your email accounts.',
    label: 'Chat',
  },
  mail: {
    description: 'Connect your email and calendar accounts, and choose what your agents may do with them.',
    label: 'Mail and calendar',
  },
  tickets: {
    description:
      'Connect the accounts your projects’ ticket and code tools sign in with, shared by the work '
      + 'in each project.',
    label: 'Tickets and code',
  },
}

/** The tab a synced account is listed on — where its row is, and where its page returns. */
export const PROVIDER_TAB: Record<CommsProvider, ConnectionTab> = {
  google: 'mail',
  microsoft: 'mail',
  slack: 'chat',
}

/**
 * The tab a provider named by an OAuth return belongs to. The value arrives in
 * the address, so anything that is not a provider this admin knows names no tab.
 */
export const tabForProvider = (value: string | null): ConnectionTab | null => {
  const provider = CommsProviderSchema.safeParse(value)
  return provider.success ? PROVIDER_TAB[provider.data] : null
}

/** Connected accounts opened at one tab; the default tab is the bare address. */
export const connectedAccountsPath = (tab: ConnectionTab): string =>
  tab === DEFAULT_CONNECTION_TAB ? '/settings/accounts' : `/settings/accounts?tab=${tab}`
