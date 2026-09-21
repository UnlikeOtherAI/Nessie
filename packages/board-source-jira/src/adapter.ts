import { createHash } from 'node:crypto'

import {
  type AssetStream,
  type BoardSourceAdapter,
  type ConnectResult,
  type ConnectionContext,
  type ContainerDescription,
  type ContainerDescriptor,
  type CredentialBundle,
  type NormalisedComment,
  type NormalisedItem,
  type OAuthExchangeInput,
  type OutboundChange,
  type RemoteItemQuery,
  SourceContainerGoneError,
  SourceRejectedError,
  type SyncCheckpoint,
  type SyncPage,
  type WebhookDelivery,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookSecrets,
  secureEquals,
} from '@nessie/board-sources'

import {
  createJiraComment,
  deleteJiraComment,
  fetchJiraAsset,
  topUpComments,
  updateJiraComment,
} from './activity.js'
import {
  ISSUE_FIELDS,
  JIRA_ALLOWED_HOSTS,
  JIRA_API_HOST,
  JIRA_AUTH_HOST,
  JIRA_SYNC_PAGE_SIZE,
  type JiraTransport,
  SYNC_FIELDS,
  apiBase,
  authHeaders,
  defaultJiraTransport,
} from './http.js'
import {
  JIRA_ASSET_HOSTS,
  type JiraIssue,
  jiraStatusCategory,
  normaliseJiraIssue,
} from './normalise.js'
import { jiraSearchJql } from './search.js'
import { parseJiraWebhook } from './webhook-parse.js'

export { JIRA_ALLOWED_HOSTS, JIRA_API_HOST, JIRA_AUTH_HOST } from './http.js'

const SCOPES = 'read:jira-work write:jira-work read:jira-user offline_access'

export type JiraAdapterConfig = {
  clientId: string
  clientSecret: string
  /** Recorded answers in tests; production never sets it. */
  transport?: Partial<JiraTransport>
}

/**
 * The events a source's webhook asks for: issues, and their comments — a
 * comment deletion only ever arrives this way, polling cannot see an absence.
 */
export const JIRA_WEBHOOK_EVENTS = [
  'jira:issue_created',
  'jira:issue_updated',
  'jira:issue_deleted',
  'comment_created',
  'comment_updated',
  'comment_deleted',
] as const

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
export const createJiraAdapter = (config: JiraAdapterConfig): BoardSourceAdapter => {
  const http: JiraTransport = { ...defaultJiraTransport, ...config.transport }
  return {
    provider: 'jira',
    incrementalPollingIntervalMs: 5 * 60 * 1000,
    allowedHosts: JIRA_ALLOWED_HOSTS,

    assetHosts: JIRA_ASSET_HOSTS,

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
          const token = await http.json<{
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
          const me = await http.json<{ account_id: string }>({
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
          const token = await http.json<{
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
      const sites = await http.json<{ id: string; name: string; url: string }[]>({
        url: `https://${JIRA_API_HOST}/oauth/token/accessible-resources`,
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })
      const containers: ContainerDescriptor[] = []
      for (const site of sites) {
        const projects = await http.json<{
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
        statuses = await http.json({
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

      const members = await http.json<
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
        // Labels are first-class, so they are no longer a custom field. Jira
        // keeps no per-project label list (labels are bare site-wide strings with
        // no colour), so the list is empty — which still tells the attach to map
        // `labels` onto native labels — and each label arrives with its issues.
        fields: [{ key: 'issuetype', label: 'Type', type: 'select' }],
        labels: [],
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
      url.searchParams.set('maxResults', String(JIRA_SYNC_PAGE_SIZE))
      // Comments and files ride on the issue: Jira has no flat comment feed a
      // project could be walked by, so there is no separate comment lane.
      url.searchParams.set('fields', SYNC_FIELDS)
      if (checkpoint.cursor) url.searchParams.set('nextPageToken', checkpoint.cursor)

      const page = await http.json<{
        issues?: JiraIssue[]
        nextPageToken?: string
        isLast?: boolean
      }>({
        url: url.toString(),
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })

      const items = (page.issues ?? []).map((issue) => normaliseJiraIssue(issue, siteUrl, cloudId))
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
      url.searchParams.set('fields', SYNC_FIELDS)
      url.searchParams.set('maxResults', '100')
      const page = await http.json<{ issues?: JiraIssue[] }>({
        url: url.toString(),
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })
      const issues = await Promise.all(
        (page.issues ?? []).map((issue) => topUpComments(http, ctx, container, issue)),
      )
      return issues.map((issue) => normaliseJiraIssue(issue, siteUrl, cloudId))
    },

    searchItems: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      query: RemoteItemQuery,
    ): Promise<NormalisedItem[]> => {
      const cloudId = String(container.cloudId ?? '')
      const siteUrl = String(container.siteUrl ?? '')
      const projectKey = String(container.projectKey ?? '')
      const url = new URL(`${apiBase(cloudId)}/search/jql`)
      url.searchParams.set('jql', jiraSearchJql(projectKey, query.text))
      url.searchParams.set('fields', ISSUE_FIELDS)
      url.searchParams.set('maxResults', String(Math.min(query.limit, 100)))
      const page = await http.json<{ issues?: JiraIssue[] }>({
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
      const registered = await http.json<{
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
              events: [...JIRA_WEBHOOK_EVENTS],
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

    parseWebhook: (request: WebhookRequest): WebhookDelivery => parseJiraWebhook(request),

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
        const available = await http.json<{
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
        await http.json({
          url: `${apiBase(cloudId)}/issue/${item.externalKey}/transitions`,
          method: 'POST',
          allowedHosts: JIRA_ALLOWED_HOSTS,
          headers: authHeaders(ctx),
          body: JSON.stringify({ transition: { id: transition.id } }),
        })
      }

      if (change.assigneeExternalUserId !== undefined) {
        await http.json({
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
      // A Jira label *is* its name, which is also the id the mirror keeps.
      if (change.labelIds !== undefined) fields.labels = change.labelIds
      if (Object.keys(fields).length > 0) {
        await http.json({
          url: `${apiBase(cloudId)}/issue/${item.externalKey}`,
          method: 'PUT',
          allowedHosts: JIRA_ALLOWED_HOSTS,
          headers: authHeaders(ctx),
          body: JSON.stringify({ fields }),
        })
      }

      // Re-read rather than trusting the request: what the board shows is what
      // Jira actually stored, workflow post-functions and all.
      const echo = await http.json<JiraIssue>({
        url: `${apiBase(cloudId)}/issue/${item.externalKey}?fields=${ISSUE_FIELDS}`,
        allowedHosts: JIRA_ALLOWED_HOSTS,
        headers: authHeaders(ctx),
      })
      return normaliseJiraIssue(echo, siteUrl, cloudId)
    },

    fetchAsset: (ctx: ConnectionContext, asset: { url: string }): Promise<AssetStream | null> =>
      fetchJiraAsset(http, ctx, asset),

    createComment: (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      item: { externalId: string; externalKey: string },
      body: string,
    ): Promise<NormalisedComment> => createJiraComment(http, ctx, container, item, body),

    updateComment: (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      comment: { externalId: string },
      body: string,
    ): Promise<NormalisedComment> => updateJiraComment(http, ctx, container, comment, body),

    deleteComment: (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      comment: { externalId: string },
    ): Promise<void> => deleteJiraComment(http, ctx, container, comment),
  }
}
