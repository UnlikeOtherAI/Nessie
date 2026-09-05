import { createHash } from 'node:crypto'

import {
  type BoardSourceAdapter,
  type ConnectResult,
  type ConnectionContext,
  type ContainerDescription,
  type ContainerDescriptor,
  type CredentialBundle,
  type NormalisedItem,
  type OAuthExchangeInput,
  type OutboundChange,
  SourceContainerGoneError,
  SourceRejectedError,
  type SyncCheckpoint,
  type SyncPage,
  type WebhookDelivery,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookSecrets,
  secureEquals,
  sourceFetchJson,
} from '@nessie/board-sources'

import {
  type JiraIssue,
  jiraStatusCategory,
  normaliseJiraIssue,
} from './normalise.js'

export const JIRA_API_HOST = 'api.atlassian.com'
export const JIRA_AUTH_HOST = 'auth.atlassian.com'
export const JIRA_ALLOWED_HOSTS = [JIRA_API_HOST, JIRA_AUTH_HOST] as const

const SCOPES = 'read:jira-work write:jira-work read:jira-user offline_access'
const ISSUE_FIELDS = 'summary,description,status,assignee,priority,duedate,labels,created,updated,issuetype'

export type JiraAdapterConfig = { clientId: string; clientSecret: string }

const apiBase = (cloudId: string): string =>
  `https://${JIRA_API_HOST}/ex/jira/${cloudId}/rest/api/3`

const authHeaders = (ctx: ConnectionContext): Record<string, string> => ({
  authorization: `Bearer ${ctx.credential.accessToken}`,
  'content-type': 'application/json',
})

/**
 * Jira Cloud as a board source, over 3LO OAuth and the v3 REST API.
 *
 * Two Jira facts shape this adapter. Its webhooks are **unsigned** and expire
 * after 30 days, so authenticity comes from a per-source callback token whose
 * hash is all that is stored, and a renewal sweep keeps them alive. And a
 * status change is a *transition*, not an assignment: moving an issue means
 * finding a transition whose target is the state we want, which is why a move
 * a workflow forbids is refused by name rather than silently ignored.
 */
export const createJiraAdapter = (config: JiraAdapterConfig): BoardSourceAdapter => ({
  provider: 'jira',
  incrementalPollingIntervalMs: 5 * 60 * 1000,
  allowedHosts: JIRA_ALLOWED_HOSTS,

  auth: {
    oauth: {
      buildAuthorizeUrl: ({ state, redirectUri }) => {
        const url = new URL(`https://${JIRA_AUTH_HOST}/authorize`)
        url.searchParams.set('audience', JIRA_API_HOST)
        url.searchParams.set('client_id', config.clientId)
        url.searchParams.set('scope', SCOPES)
        url.searchParams.set('redirect_uri', redirectUri)
        url.searchParams.set('state', state)
        url.searchParams.set('response_type', 'code')
        // Atlassian only issues a refresh token when consent is prompted.
        url.searchParams.set('prompt', 'consent')
        return url.toString()
      },

      exchange: async ({ code, redirectUri }: OAuthExchangeInput): Promise<ConnectResult> => {
        const token = await sourceFetchJson<{
          access_token: string
          refresh_token?: string
          expires_in?: number
          scope?: string
        }>({
          url: `https://${JIRA_AUTH_HOST}/oauth/token`,
          method: 'POST',
          allowedHosts: JIRA_ALLOWED_HOSTS,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        })
        const scopes = (token.scope ?? '').split(/\s+/).filter(Boolean)
        const me = await sourceFetchJson<{ account_id: string }>({
          url: `https://${JIRA_API_HOST}/me`,
          allowedHosts: JIRA_ALLOWED_HOSTS,
          headers: { authorization: `Bearer ${token.access_token}` },
        })
        return {
          externalAccountId: me.account_id,
          // A 3LO token spans every site the person granted, so the tenant is not
          // on the connection — each container carries its own `cloudId`.
          externalTenantId: '',
          credential: {
            accessToken: token.access_token,
            ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}),
            ...(token.expires_in
              ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
              : {}),
            scopes,
          },
          grantedScopes: scopes,
        }
      },

      refresh: async (credential: CredentialBundle): Promise<CredentialBundle> => {
        if (!credential.refreshToken) return credential
        const token = await sourceFetchJson<{
          access_token: string
          refresh_token?: string
          expires_in?: number
        }>({
          url: `https://${JIRA_AUTH_HOST}/oauth/token`,
          method: 'POST',
          allowedHosts: JIRA_ALLOWED_HOSTS,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: credential.refreshToken,
          }),
        })
        return {
          accessToken: token.access_token,
          // Atlassian rotates refresh tokens: keeping the old one would end the
          // connection at the next refresh.
          refreshToken: token.refresh_token ?? credential.refreshToken,
          ...(token.expires_in
            ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
            : {}),
          scopes: credential.scopes,
        }
      },
    },
  },

  listContainers: async (ctx: ConnectionContext): Promise<ContainerDescriptor[]> => {
    const sites = await sourceFetchJson<{ id: string; name: string; url: string }[]>({
      url: `https://${JIRA_API_HOST}/oauth/token/accessible-resources`,
      allowedHosts: JIRA_ALLOWED_HOSTS,
      headers: authHeaders(ctx),
    })
    const containers: ContainerDescriptor[] = []
    for (const site of sites) {
      const projects = await sourceFetchJson<{
        values: { id: string; key: string; name: string }[]
      }>({
        url: `${apiBase(site.id)}/project/search?maxResults=50`,
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })
      for (const project of projects.values ?? []) {
        containers.push({
          key: `${site.id}:${project.key}`,
          container: { cloudId: site.id, projectKey: project.key, siteUrl: site.url },
          label: project.name,
          hint: `${site.name} · ${project.key}`,
        })
      }
    }
    return containers
  },

  describeContainer: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
  ): Promise<ContainerDescription> => {
    const cloudId = String(container.cloudId ?? '')
    const projectKey = String(container.projectKey ?? '')

    let statuses: {
      statuses: { id: string; name: string; statusCategory?: { key?: string } }[]
    }[]
    try {
      statuses = await sourceFetchJson({
        url: `${apiBase(cloudId)}/project/${encodeURIComponent(projectKey)}/statuses`,
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })
    } catch {
      throw new SourceContainerGoneError('That Jira project is no longer reachable')
    }

    // One project's statuses are listed per issue type and repeat across them.
    const seen = new Map<string, { id: string; name: string; category: string | undefined }>()
    for (const type of statuses) {
      for (const status of type.statuses ?? []) {
        if (!seen.has(status.id)) {
          seen.set(status.id, {
            id: status.id,
            name: status.name,
            category: status.statusCategory?.key,
          })
        }
      }
    }

    const members = await sourceFetchJson<
      { accountId: string; displayName: string; emailAddress?: string; accountType?: string }[]
    >({
      url: `${apiBase(cloudId)}/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=100`,
      allowedHosts: JIRA_ALLOWED_HOSTS,
      headers: authHeaders(ctx),
    }).catch(() => [])

    return {
      states: [...seen.values()].map((status) => ({
        id: status.id,
        name: status.name,
        suggestedCategory: jiraStatusCategory(status.category),
      })),
      fields: [
        { key: 'labels', label: 'Labels', type: 'multi_select' },
        { key: 'issuetype', label: 'Type', type: 'select' },
      ],
      members: members
        .filter((member) => member.accountType !== 'app')
        .map((member) => ({
          externalUserId: member.accountId,
          displayName: member.displayName,
          ...(member.emailAddress ? { email: member.emailAddress } : {}),
        })),
    }
  },

  fetchPage: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    checkpoint: SyncCheckpoint,
    options: { syncWindowDays: number },
  ): Promise<SyncPage> => {
    const cloudId = String(container.cloudId ?? '')
    const projectKey = String(container.projectKey ?? '')
    const siteUrl = String(container.siteUrl ?? '')
    const since =
      checkpoint.since ??
      new Date(Date.now() - options.syncWindowDays * 24 * 60 * 60 * 1000).toISOString()

    // JQL takes minutes, not ISO timestamps, for a relative bound — an absolute
    // one is quoted `yyyy-MM-dd HH:mm`.
    const sinceClause = `updated >= "${since.slice(0, 16).replace('T', ' ')}"`
    const jql = `project = "${projectKey}" AND ${sinceClause} ORDER BY updated ASC`

    const url = new URL(`${apiBase(cloudId)}/search/jql`)
    url.searchParams.set('jql', jql)
    url.searchParams.set('maxResults', '100')
    url.searchParams.set('fields', ISSUE_FIELDS)
    if (checkpoint.cursor) url.searchParams.set('nextPageToken', checkpoint.cursor)

    const page = await sourceFetchJson<{
      issues?: JiraIssue[]
      nextPageToken?: string
      isLast?: boolean
    }>({
      url: url.toString(),
      allowedHosts: JIRA_ALLOWED_HOSTS,
      headers: authHeaders(ctx),
    })

    const items = (page.issues ?? []).map((issue) => normaliseJiraIssue(issue, siteUrl))
    const hasMore = Boolean(page.nextPageToken) && page.isLast !== true
    const latest = items.reduce<string | null>(
      (newest, item) => (newest === null || item.updatedAt > newest ? item.updatedAt : newest),
      null,
    )

    return {
      items,
      hasMore,
      checkpoint: hasMore
        ? { phase: checkpoint.phase, since, cursor: page.nextPageToken as string }
        : {
            phase: 'incremental',
            // Five minutes of overlap: JQL's `updated` has minute granularity,
            // so a tighter bound would drop issues written in the boundary
            // minute.
            since: latest
              ? new Date(Date.parse(latest) - 5 * 60_000).toISOString()
              : since,
          },
    }
  },

  fetchItems: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    externalIds: string[],
  ): Promise<NormalisedItem[]> => {
    if (externalIds.length === 0) return []
    const cloudId = String(container.cloudId ?? '')
    const siteUrl = String(container.siteUrl ?? '')
    const url = new URL(`${apiBase(cloudId)}/search/jql`)
    url.searchParams.set('jql', `id IN (${externalIds.slice(0, 100).join(',')})`)
    url.searchParams.set('fields', ISSUE_FIELDS)
    url.searchParams.set('maxResults', '100')
    const page = await sourceFetchJson<{ issues?: JiraIssue[] }>({
      url: url.toString(),
      allowedHosts: JIRA_ALLOWED_HOSTS,
      headers: authHeaders(ctx),
    })
    return (page.issues ?? []).map((issue) => normaliseJiraIssue(issue, siteUrl))
  },

  ensureWebhook: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    callback: { url: string },
  ): Promise<WebhookRegistration | null> => {
    const cloudId = String(container.cloudId ?? '')
    const projectKey = String(container.projectKey ?? '')
    const registered = await sourceFetchJson<{
      webhookRegistrationResult?: { createdWebhookId?: number; errors?: string[] }[]
    }>({
      url: `${apiBase(cloudId)}/webhook`,
      method: 'POST',
      allowedHosts: JIRA_ALLOWED_HOSTS,
      headers: authHeaders(ctx),
      body: JSON.stringify({
        url: callback.url,
        webhooks: [
          {
            jqlFilter: `project = "${projectKey}"`,
            events: ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'],
          },
        ],
      }),
    })
    const created = registered.webhookRegistrationResult?.[0]?.createdWebhookId
    if (!created) return null
    return {
      externalId: String(created),
      // Jira expires a webhook after 30 days unless it is refreshed; the
      // renewal sweep uses this.
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }
  },

  // Jira does not sign its deliveries at all, so authenticity is the
  // unguessable per-source token in the callback path — compared against the
  // stored hash in constant time, never against a stored plaintext.
  verifyWebhook: (request: WebhookRequest, secrets: WebhookSecrets): boolean => {
    if (!request.token || !secrets.tokenHash) return false
    return secureEquals(
      createHash('sha256').update(request.token).digest('hex'),
      secrets.tokenHash,
    )
  },

  parseWebhook: (request: WebhookRequest): WebhookDelivery => {
    const parsed = JSON.parse(request.rawBody) as {
      timestamp?: number
      webhookEvent?: string
      issue?: { id?: string; fields?: { project?: { id?: string; key?: string } } }
    }
    return {
      deliveryId: `jira:${parsed.issue?.id ?? 'none'}:${parsed.timestamp ?? 0}`,
      // The delivery names the project, not the site, so the source is found by
      // its token rather than by a container key.
      containerKey: null,
      externalIds: parsed.issue?.id ? [parsed.issue.id] : [],
    }
  },

  applyChange: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    item: { externalId: string; externalKey: string },
    change: OutboundChange,
  ): Promise<NormalisedItem> => {
    const cloudId = String(container.cloudId ?? '')
    const siteUrl = String(container.siteUrl ?? '')

    // A status is a transition Jira's workflow either offers or does not. There
    // is no way to assign one directly, and a workflow that forbids the move is
    // a refusal a person needs to read — not a silent no-op.
    if (change.stateId) {
      const available = await sourceFetchJson<{
        transitions?: { id: string; to?: { id?: string; name?: string } }[]
      }>({
        url: `${apiBase(cloudId)}/issue/${item.externalKey}/transitions`,
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })
      const transition = (available.transitions ?? []).find(
        (candidate) => candidate.to?.id === change.stateId,
      )
      if (!transition) {
        throw new SourceRejectedError(
          'JIRA_NO_TRANSITION',
          `${item.externalKey} has no transition to that status from its current one.`,
        )
      }
      await sourceFetchJson({
        url: `${apiBase(cloudId)}/issue/${item.externalKey}/transitions`,
        method: 'POST',
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
        body: JSON.stringify({ transition: { id: transition.id } }),
      })
    }

    if (change.assigneeExternalUserId !== undefined) {
      await sourceFetchJson({
        url: `${apiBase(cloudId)}/issue/${item.externalKey}/assignee`,
        method: 'PUT',
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
        body: JSON.stringify({ accountId: change.assigneeExternalUserId }),
      })
    }

    const fields: Record<string, unknown> = {}
    if (change.title !== undefined) fields.summary = change.title
    if (change.dueDate !== undefined) fields.duedate = change.dueDate
    if (Object.keys(fields).length > 0) {
      await sourceFetchJson({
        url: `${apiBase(cloudId)}/issue/${item.externalKey}`,
        method: 'PUT',
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
        body: JSON.stringify({ fields }),
      })
    }

    // Re-read rather than trusting the request: what the board shows is what
    // Jira actually stored, workflow post-functions and all.
    const echo = await sourceFetchJson<JiraIssue>({
      url: `${apiBase(cloudId)}/issue/${item.externalKey}?fields=${ISSUE_FIELDS}`,
      allowedHosts: JIRA_ALLOWED_HOSTS,
      headers: authHeaders(ctx),
    })
    return normaliseJiraIssue(echo, siteUrl)
  },
})
