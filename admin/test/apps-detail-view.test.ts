import assert from 'node:assert/strict'
import test from 'node:test'

import type { AppConnectionSummaryRecord, AppDetailRecord } from '@nessie/schemas'

import {
  agentsAccessEmptyMessage,
  appCapabilityCount,
  appConnectCtaLabel,
  appDetailCta,
  appDetailLinks,
  appDetailStats,
  appDetailTabs,
  appHeroMeta,
  appIsConnected,
  appNotFoundMessage,
  appProviderLine,
  capabilitiesNote,
  resolveAppDetailTab,
} from '../src/components/features/apps/app-detail-view.js'

/**
 * The app detail page is the member surface: connect, accounts, capabilities,
 * agents. Health probes, failure counts, endpoints and credentials are
 * owner-ops facts that belong on the Connectors page and never render here.
 */

const connection = (
  overrides: Partial<AppConnectionSummaryRecord> = {},
): AppConnectionSummaryRecord => ({
  displayName: 'Ada Lovelace',
  errorMessage: null,
  id: 'conn-1',
  lastConnectedAt: '2026-08-01T00:00:00.000Z',
  scopeId: 'user-1',
  scopeType: 'user',
  status: 'connected',
  ...overrides,
})

const detail = (overrides: Partial<AppDetailRecord> = {}): AppDetailRecord => ({
  agentsWithAccess: [],
  aliases: [],
  appSource: 'nessie',
  capabilities: { tools: [] },
  categories: ['development'],
  connectionCount: 0,
  connections: [],
  displayName: 'GitHub',
  distribution: 'remote',
  documentationUrl: null,
  featured: false,
  featuredOrder: null,
  iconUrl: null,
  id: 'app-1',
  installHref: '/mcp-app-store?catalogEntryId=app-1&action=install',
  locked: false,
  longDescription: null,
  managedByIntegration: false,
  name: 'github',
  primaryCategory: 'development',
  promptCount: null,
  repositoryUrl: null,
  resourceCount: null,
  shortDescription: 'Repositories, issues and pull requests.',
  slug: 'github',
  state: 'available',
  tags: [],
  toolCount: null,
  trustLevel: 'verified',
  vendor: null,
  websiteUrl: null,
  ...overrides,
})

const tool = (name: string): { description: string; name: string } => ({
  description: `Does ${name}`,
  name,
})

test('Connected accounts appears only once there is an account to list', () => {
  // Before connecting, an empty tab teaches a person the app has no accounts —
  // which they know, having not connected it.
  assert.deepEqual(
    appDetailTabs(detail()).map((tab) => tab.id),
    ['overview', 'capabilities', 'agents'],
  )

  const connected = detail({ connections: [connection(), connection({ id: 'conn-2' })] })
  assert.equal(appIsConnected(connected), true)
  assert.deepEqual(appDetailTabs(connected).map((tab) => tab.id), [
    'overview',
    'capabilities',
    'accounts',
    'agents',
  ])
  assert.deepEqual(
    appDetailTabs(connected).find((tab) => tab.id === 'accounts'),
    { count: 2, id: 'accounts', label: 'Connected accounts' },
  )
})

test('the capability count prefers the probed list and falls back to the stored one', () => {
  assert.equal(appCapabilityCount(detail({ capabilities: { tools: [tool('a'), tool('b')] }, toolCount: 9 })), 2)
  assert.equal(appCapabilityCount(detail({ toolCount: 9 })), 9)
  assert.equal(appCapabilityCount(detail()), null)
})

test('a tab with nothing to count keeps its label alone rather than reading (0)', () => {
  const tabs = appDetailTabs(detail())
  assert.equal(tabs.find((tab) => tab.id === 'overview')?.count, null)
  assert.equal(tabs.find((tab) => tab.id === 'capabilities')?.count, null)
  assert.equal(tabs.find((tab) => tab.id === 'agents')?.count, null)

  const populated = appDetailTabs(
    detail({ agentsWithAccess: [{ agentId: 'agent-1', name: 'Scout', role: null }], toolCount: 3 }),
  )
  assert.equal(populated.find((tab) => tab.id === 'capabilities')?.count, 3)
  assert.equal(populated.find((tab) => tab.id === 'agents')?.count, 1)
})

test('a deep link to a tab this app does not offer falls back to Overview, not a blank panel', () => {
  const tabs = appDetailTabs(detail())
  // An old bookmark, or a link pasted before the app was disconnected.
  assert.equal(resolveAppDetailTab('accounts', tabs), 'overview')
  assert.equal(resolveAppDetailTab('nonsense', tabs), 'overview')
  assert.equal(resolveAppDetailTab(null, tabs), 'overview')
  assert.equal(resolveAppDetailTab('agents', tabs), 'agents')
  assert.equal(resolveAppDetailTab('accounts', appDetailTabs(detail({ connections: [connection()] }))), 'accounts')
})

test('the connect label is the one word Connect — the page already names both parties', () => {
  // It used to read "Connect Nessie to GitHub" wherever there was room. The
  // person is on GitHub's page, under GitHub's name and icon, having clicked
  // GitHub's card: restating both parties is words, not information.
  assert.equal(appConnectCtaLabel(), 'Connect')
  // No parameters at all, so the label cannot vary by app or by screen width —
  // a re-introduced display name would have to come back through this signature.
  assert.equal(appConnectCtaLabel.length, 0)
})

test('the hero CTA is the card decision, pointed at the server own install route', () => {
  const app = detail()
  assert.deepEqual(appDetailCta(app), {
    kind: 'link',
    href: app.installHref,
    label: 'Connect',
    tone: 'primary',
  })
})

test('a blocked connect keeps its disabled shape and reason', () => {
  assert.deepEqual(appDetailCta(detail({ locked: true })), {
    kind: 'disabled',
    label: 'Connect',
    title: 'Managed by your admin.',
    tone: 'primary',
  })
})

test('an action that is not Connect passes through untouched', () => {
  const connected = detail({ connections: [connection()], state: 'connected' })
  assert.deepEqual(appDetailCta(connected), {
    kind: 'link',
    href: '/apps/github?tab=accounts',
    label: 'Manage',
    tone: 'secondary',
  })
  assert.deepEqual(appDetailCta(detail({ state: 'auth_expired' })), {
    kind: 'link',
    href: detail().installHref,
    label: 'Reconnect',
    tone: 'primary',
  })
  assert.deepEqual(appDetailCta(detail({ state: 'unavailable' })), { kind: 'none' })
})

test('the provider line names the publisher when one claims the app, and the category always', () => {
  assert.equal(appProviderLine(detail({ vendor: 'GitHub, Inc.' })), 'by GitHub, Inc. · Development')
  assert.equal(appProviderLine(detail()), 'Development')
  assert.equal(appProviderLine(detail({ primaryCategory: 'crm_sales' })), 'CRM & Sales')
})

test('the hero meta says what you get, or nothing at all before the app has been probed', () => {
  assert.equal(appHeroMeta(detail({ toolCount: 1 })), '1 capability')
  assert.equal(appHeroMeta(detail({ toolCount: 12 })), '12 capabilities')
  assert.equal(appHeroMeta(detail()), null)
})

test('a stat tile with nothing to report is cut rather than shown as zero', () => {
  assert.deepEqual(appDetailStats(detail()), [])
  assert.deepEqual(
    appDetailStats(
      detail({
        connections: [connection()],
        promptCount: 2,
        resourceCount: 7,
        toolCount: 0,
      }),
    ),
    [
      // A probed zero is a report, not an absence: the app answered "none".
      { label: 'Capabilities', value: '0' },
      { label: 'Resources', value: '7' },
      { label: 'Prompts', value: '2' },
      { label: 'Accounts', value: '1' },
    ],
  )
})

test('links render in a fixed order and the ones the app did not give are dropped', () => {
  assert.deepEqual(appDetailLinks(detail()), [])
  assert.deepEqual(
    appDetailLinks(detail({ repositoryUrl: 'https://github.com/o/r', websiteUrl: 'https://example.com' })),
    [
      { href: 'https://example.com', label: 'Website' },
      { href: 'https://github.com/o/r', label: 'Source code' },
    ],
  )
})

test('why an agent cannot see this tool depends on one fact: whether the app is connected', () => {
  assert.equal(
    agentsAccessEmptyMessage(detail()).body,
    'Connect the app first, then choose which agents may use it.',
  )
  assert.match(
    agentsAccessEmptyMessage(detail({ connections: [connection()] })).body,
    /^This app is connected, but no agent has permission to use it\./,
  )
})

test('the capabilities note says which of the two lists a person is looking at', () => {
  assert.equal(
    capabilitiesNote(detail()),
    "This app hasn't said what it can do yet. Connect it to find out.",
  )
  assert.equal(
    capabilitiesNote(detail({ capabilities: { tools: [tool('a')] } })),
    'Connect to enable these for your agents.',
  )
  assert.equal(
    capabilitiesNote(detail({ capabilities: { tools: [tool('a')] }, connections: [connection()] })),
    null,
  )
})

test('a missing app says whether it is still loading before it says it does not exist', () => {
  assert.equal(appNotFoundMessage(true), 'Loading app…')
  assert.equal(appNotFoundMessage(false), 'This app could not be found.')
})
