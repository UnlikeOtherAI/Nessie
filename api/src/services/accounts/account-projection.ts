import {
  GOOGLE_CAPABILITIES,
  formatAccountId,
  usableCapabilities,
  type AccountAction,
  type AccountOwner,
  type AccountRecord,
  type GoogleCapabilityId,
  type IntegrationSlug,
  type McpServerLifecycleState,
} from '@nessie/schemas'

import {
  aiPlanAccountStatus,
  appAccountStatus,
  browserAccountStatus,
  commsAccountStatus,
  mailboxAccountStatus,
  ticketsAccountStatus,
} from './account-status.js'

/**
 * The row builders: one per store, each a pure function of the row it reads,
 * so the list, an account's page and Check access all describe an account
 * the same way. Services are named by their names; how an account connects
 * (a password, a key, a sign-in) is never the row's label.
 */

const iso = (value: Date | null): string | null => value?.toISOString() ?? null

const viewerOwner = (userId: string): AccountOwner => ({
  displayName: null,
  isViewer: true,
  kind: 'person',
  userId,
})

// ─── Google, Microsoft, Slack ───────────────────────────────────────────────

export type CommsProviderKey = 'google' | 'microsoft' | 'slack'

export const COMMS_SERVICE: Record<CommsProviderKey, {
  integration: IntegrationSlug
  name: string
  purpose: 'mail' | 'chat'
}> = {
  google: { integration: 'google-workspace', name: 'Google Workspace', purpose: 'mail' },
  microsoft: { integration: 'microsoft-365', name: 'Microsoft 365', purpose: 'mail' },
  slack: { integration: 'slack', name: 'Slack', purpose: 'chat' },
}

export type CommsAccountInput = {
  createdAt: Date
  disabledCapabilities: GoogleCapabilityId[]
  externalTenantId: string
  externalUserId: string
  grantedScopes: string[]
  id: string
  lastSuccessfulSyncAt: Date | null
  ownerUserId: string
  provider: CommsProviderKey
  status: 'active' | 'needs_reauthorization' | 'disconnected' | 'error'
}

/** What a Google account lets agents do: the catalog's own labels, granted and not blocked. */
export const googleCapabilityLabels = (input: {
  disabledCapabilities: readonly GoogleCapabilityId[]
  grantedScopes: readonly string[]
}): string[] => {
  const usable = new Set(usableCapabilities(input))
  return GOOGLE_CAPABILITIES.filter((capability) => usable.has(capability.id))
    .map((capability) => capability.label)
}

export const projectCommsAccount = (input: CommsAccountInput): AccountRecord => {
  const service = COMMS_SERVICE[input.provider]
  const capabilities = input.provider === 'google'
    ? googleCapabilityLabels(input)
    : input.provider === 'microsoft' ? ['Read your email'] : ['Read your messages']
  const off = input.status === 'disconnected'
  const actions: AccountAction[] = []
  if (input.provider === 'google' && input.status === 'active'
    && usableCapabilities(input).includes('gmail.read')) {
    actions.push('open_mail')
  }
  if (!off) actions.push('resync')
  if (input.status !== 'active') actions.push('reconnect')
  if (!off) actions.push('disconnect')
  return {
    actions,
    // Google's tools act as the person asking, in their own conversations. No
    // agent tool reads a Microsoft or Slack account: their mail and messages
    // are imported, and what they wake is an automation, not an agent's reach.
    agents: {
      canManage: false,
      count: null,
      rule: input.provider === 'google' ? 'requester' : 'not_used',
    },
    capabilities,
    connectedAt: input.createdAt.toISOString(),
    detail: input.provider === 'slack' ? `Workspace ${input.externalTenantId}` : null,
    id: formatAccountId('comms', input.id),
    integration: service.integration,
    kind: 'comms',
    label: input.externalUserId,
    lastActiveAt: iso(input.lastSuccessfulSyncAt),
    owner: viewerOwner(input.ownerUserId),
    purpose: service.purpose,
    scope: 'person',
    service: input.provider,
    serviceName: service.name,
    status: commsAccountStatus(input.status, service.name),
  }
}

// ─── Another email provider ─────────────────────────────────────────────────

export type MailboxAccountInput = {
  address: string
  agentIds: string[]
  createdAt: Date
  id: string
  label: string
  lastVerifiedAt: Date | null
  ownerUserId: string | null
  status: 'active' | 'needs_reauthorization' | 'disabled'
  team: { id: string; name: string } | null
}

export const projectMailboxAccount = (
  input: MailboxAccountInput,
  viewer: { canManage: boolean; userId: string },
): AccountRecord => {
  const actions: AccountAction[] = []
  if (input.status === 'active') actions.push('open_mail')
  if (viewer.canManage) {
    actions.push('test')
    if (input.status === 'needs_reauthorization') actions.push('reconnect')
    actions.push('disconnect')
  }
  const owner: AccountOwner = input.team
    ? { kind: 'team', name: input.team.name, teamId: input.team.id }
    : {
        displayName: null,
        isViewer: input.ownerUserId === viewer.userId,
        kind: 'person',
        userId: input.ownerUserId ?? viewer.userId,
      }
  return {
    actions,
    agents: { canManage: viewer.canManage, count: input.agentIds.length, rule: 'listed' },
    capabilities: ['Read mail', 'Send mail, each message approved first'],
    connectedAt: input.createdAt.toISOString(),
    detail: input.label !== input.address ? input.label : null,
    id: formatAccountId('mailbox', input.id),
    integration: null,
    kind: 'mailbox',
    label: input.address,
    lastActiveAt: iso(input.lastVerifiedAt),
    owner,
    purpose: 'mail',
    scope: input.team ? 'team' : 'person',
    service: 'imap',
    serviceName: 'Other email provider',
    status: mailboxAccountStatus(input.status),
  }
}

// ─── Ticket and code tools ──────────────────────────────────────────────────

export type TicketsProviderKey = 'jira' | 'linear' | 'trello' | 'github'

export const TICKETS_SERVICE_NAME: Record<TicketsProviderKey, string> = {
  github: 'GitHub',
  jira: 'Jira',
  linear: 'Linear',
  trello: 'Trello',
}

export type TicketsAccountInput = {
  authMethod: 'oauth' | 'api_key'
  createdAt: Date
  externalAccountId: string
  externalTenantId: string
  id: string
  lastVerifiedAt: Date | null
  ownerUserId: string
  provider: TicketsProviderKey
  status: 'active' | 'needs_reauthorization' | 'revoked'
}

export const projectTicketsAccount = (input: TicketsAccountInput): AccountRecord => {
  const name = TICKETS_SERVICE_NAME[input.provider]
  // A pasted key is replaced where it was pasted — a project's Connected
  // tools — so only a sign-in can be reconnected from the row.
  const actions: AccountAction[] = input.authMethod === 'oauth'
    ? ['reconnect', 'disconnect']
    : ['disconnect']
  return {
    actions,
    agents: { canManage: false, count: null, rule: 'not_used' },
    capabilities: ['Sync boards into projects'],
    connectedAt: input.createdAt.toISOString(),
    detail: input.externalTenantId && input.externalTenantId !== input.externalAccountId
      ? input.externalTenantId
      : null,
    id: formatAccountId('tickets', input.id),
    integration: input.provider,
    kind: 'tickets',
    label: input.externalAccountId,
    lastActiveAt: iso(input.lastVerifiedAt),
    owner: viewerOwner(input.ownerUserId),
    purpose: 'tickets',
    scope: 'person',
    service: input.provider,
    serviceName: name,
    status: ticketsAccountStatus(input.status, name),
  }
}

// ─── AI plans ───────────────────────────────────────────────────────────────

export type AiPlanAccountInput = {
  accountLabel: string | null
  createdAt: Date
  healthReason: Parameters<typeof aiPlanAccountStatus>[0]['healthReason']
  id: string
  lastUsedAt: Date | null
  pinnedAgentCount: number
  provider: string
  serviceName: string
  status: Parameters<typeof aiPlanAccountStatus>[0]['status']
  userId: string
}

export const projectAiPlanAccount = (input: AiPlanAccountInput): AccountRecord => {
  const status = aiPlanAccountStatus(input, input.serviceName)
  const actions: AccountAction[] = []
  if (status.remedy === 'reconnect') actions.push('reconnect')
  if (input.status !== 'disconnected') actions.push('disconnect')
  return {
    actions,
    agents: { canManage: false, count: input.pinnedAgentCount, rule: 'owned_agents' },
    capabilities: ['Runs the agents you own'],
    connectedAt: input.createdAt.toISOString(),
    detail: null,
    id: formatAccountId('ai-plan', input.id),
    integration: null,
    kind: 'ai-plan',
    label: input.accountLabel ?? input.serviceName,
    lastActiveAt: iso(input.lastUsedAt),
    owner: viewerOwner(input.userId),
    purpose: 'ai',
    scope: 'person',
    service: input.provider,
    serviceName: input.serviceName,
    status,
  }
}

// ─── Cloud browser ──────────────────────────────────────────────────────────

export type BrowserAccountInput = {
  createdAt: Date
  healthCheckedAt: Date | null
  healthReason: string | null
  id: string
  scope: 'organization' | 'team' | 'user'
  status: 'active' | 'needs_attention' | 'disabled'
  team: { id: string; name: string } | null
  userId: string | null
}

/**
 * A company or team account is the owner's to connect and disconnect (the
 * cloud browser routes' own gate), so only an owner is offered those actions;
 * a personal one is its own person's.
 */
export const projectBrowserAccount = (
  input: BrowserAccountInput,
  viewer: { isOwner: boolean; userId: string },
): AccountRecord => {
  const mine = input.scope === 'user' && input.userId === viewer.userId
  const mayChange = mine || (input.scope !== 'user' && viewer.isOwner)
  const status = browserAccountStatus(input)
  const actions: AccountAction[] = mayChange
    ? [...(status.remedy === 'replace_key' ? ['reconnect' as const] : []), 'disconnect']
    : []
  const owner: AccountOwner = input.scope === 'user'
    ? {
        displayName: null,
        isViewer: mine,
        kind: 'person',
        userId: input.userId ?? viewer.userId,
      }
    : input.scope === 'team' && input.team
      ? { kind: 'team', name: input.team.name, teamId: input.team.id }
      : { kind: 'organisation' }
  const label = input.scope === 'user'
    ? 'Your cloud browser account'
    : input.scope === 'team' && input.team
      ? `${input.team.name}’s cloud browser account`
      : 'The company’s cloud browser account'
  return {
    actions,
    agents: { canManage: false, count: null, rule: 'browser_grant' },
    capabilities: ['Browse the web for agents'],
    connectedAt: input.createdAt.toISOString(),
    detail: null,
    id: formatAccountId('browser', input.id),
    integration: 'cloud-browser',
    kind: 'browser',
    label,
    lastActiveAt: iso(input.healthCheckedAt),
    owner,
    purpose: 'browsers',
    scope: input.scope === 'user' ? 'person' : input.scope === 'team' ? 'team' : 'organisation',
    service: 'cloud-browser',
    serviceName: 'Cloud browser',
    status,
  }
}

// ─── A person's own app connection ──────────────────────────────────────────

export type AppAccountInput = {
  appName: string
  capabilityCount: number
  createdAt: Date
  healthLastCheckedAt: Date | null
  id: string
  lifecycleState: McpServerLifecycleState
  /** A first-party product owns this connection's lifecycle, not the person. */
  managed: boolean
  slug: string | null
  userId: string
}

export const projectAppAccount = (input: AppAccountInput): AccountRecord => {
  const status = appAccountStatus(input.lifecycleState, input.appName)
  const actions: AccountAction[] = input.managed
    ? []
    : [...(status.remedy === 'reconnect' ? ['reconnect' as const] : []), 'disconnect']
  return {
    actions,
    agents: { canManage: false, count: null, rule: 'requester' },
    capabilities: input.capabilityCount > 0
      ? [input.capabilityCount === 1 ? '1 capability' : `${input.capabilityCount} capabilities`]
      : [],
    connectedAt: input.createdAt.toISOString(),
    detail: 'Just you',
    id: formatAccountId('app', input.id),
    // A community app of the same name is never the first-party integration.
    integration: null,
    kind: 'app',
    label: input.appName,
    lastActiveAt: status.word === 'connected' ? iso(input.healthLastCheckedAt) : null,
    owner: viewerOwner(input.userId),
    purpose: 'apps',
    scope: 'person',
    service: input.slug ?? 'app',
    serviceName: input.appName,
    status,
  }
}
