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
  type NormalisedItemLabel,
  type OAuthExchangeInput,
  type OAuthMethod,
  type CredentialForm,
  type OutboundChange,
  type RemoteItemQuery,
  type SyncCheckpoint,
  type SyncPage,
  SourceAuthError,
  SourceContainerGoneError,
  SourceCredentialRejectedError,
  SourceHttpError,
  SourceRejectedError,
  type WebhookDelivery,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookSecrets,
  hmacHex,
  secureEquals,
  sourceFetchJson,
  sourceFetchStream,
} from '@nessie/board-sources'

import {
  LINEAR_ALLOWED_HOSTS,
  LINEAR_API_HOST,
  LINEAR_AUTH_HOST,
  linearGraphQl,
} from './graphql.js'
import { fetchCommentsLane, fetchIssuesLane, type LinearGraphQl } from './lanes.js'
import {
  LINEAR_ASSET_HOSTS,
  type LinearComment,
  type LinearIssue,
  type LinearLabel,
  linearStateCategory,
  normaliseLinearComment,
  normaliseLinearIssue,
  normaliseLinearLabel,
} from './normalise.js'
import { parseLinearWebhook } from './webhook-parse.js'
import {
  COMMENT_CREATE_MUTATION,
  COMMENT_DELETE_MUTATION,
  COMMENT_UPDATE_MUTATION,
  ISSUES_BY_ID_QUERY,
  ISSUE_SEARCH_QUERY,
  ISSUE_UPDATE_MUTATION,
  TEAMS_QUERY,
  TEAM_DESCRIPTION_QUERY,
  VIEWER_QUERY,
  WEBHOOK_CREATE_MUTATION,
  WEBHOOK_DELETE_MUTATION,
  WORKSPACE_LABELS_QUERY,
} from './queries.js'

export type LinearAdapterConfig = {
  /**
   * The deployment's OAuth app, when one is registered. Absent on an install
   * that never registered one — Linear is still fully reachable there with a
   * personal API key, which is why these are optional and `auth.oauth` is
   * declared only when both are present.
   */
  clientId?: string
  clientSecret?: string
  /** The app-level webhook signing secret, when webhooks are configured. */
  webhookSecret?: string
  /**
   * The GraphQL call, replaceable so the lane machine and the mutations can be
   * tested against recorded answers. Production never sets it: the default is
   * the one envelope every Linear call goes through.
   */
  graphQl?: LinearGraphQl
}



/**
 * The OAuth half, present only when this deployment registered a Linear app.
 * Spread into `auth`, so an install with no app simply has no `auth.oauth` and
 * the picker offers the API key alone rather than a sign-in that cannot finish.
 */
const buildOAuthMethod = (config: LinearAdapterConfig): { oauth?: OAuthMethod } => {
  const { clientId, clientSecret } = config
  if (!clientId || !clientSecret) return {}
  return {
    oauth: {
    buildAuthorizeUrl: ({ state, redirectUri }) => {
      const url = new URL(`https://${LINEAR_AUTH_HOST}/oauth/authorize`)
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', redirectUri)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('scope', 'read,write')
      // The token acts as the person who authorised it, so what the sync can
      // see is exactly what they can see.
      url.searchParams.set('actor', 'user')
      url.searchParams.set('state', state)
      return url.toString()
    },

    exchange: async ({ code, redirectUri }: OAuthExchangeInput): Promise<ConnectResult> => {
      const token = await sourceFetchJson<{
        access_token: string
        refresh_token?: string
        expires_in?: number
        scope?: string | string[]
      }>({
        url: `https://${LINEAR_API_HOST}/oauth/token`,
        method: 'POST',
        allowedHosts: LINEAR_ALLOWED_HOSTS,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }).toString(),
      })
      const scopes = Array.isArray(token.scope)
        ? token.scope
        : (token.scope ?? '').split(/[,\s]+/).filter(Boolean)

      const viewer = await linearGraphQl<{
        viewer: { id: string; name: string; email: string }
        organization: { id: string; name: string; urlKey: string }
      }>(token.access_token, VIEWER_QUERY)

      return {
        externalAccountId: viewer.viewer.id,
        externalTenantId: viewer.organization.id,
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
      // Linear tokens are long-lived unless the app opts into expiry. Without a
      // refresh token there is nothing to exchange, and pretending otherwise
      // would turn a healthy connection into a failing one.
      if (!credential.refreshToken) return credential
      const token = await sourceFetchJson<{
        access_token: string
        refresh_token?: string
        expires_in?: number
      }>({
        url: `https://${LINEAR_API_HOST}/oauth/token`,
        method: 'POST',
        allowedHosts: LINEAR_ALLOWED_HOSTS,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
        }).toString(),
      })
      return {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? credential.refreshToken,
        ...(token.expires_in
          ? { expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() }
          : {}),
        scopes: credential.scopes,
      }
    },
    },
  }
}

/**
 * A Linear personal API key: one field, pasted.
 *
 * Linear needs no site URL and no tenant discovery — the key identifies its own
 * workspace — so this is the whole form. The key's own scopes are chosen in
 * Linear when it is created, which is why the help text names them: a key made
 * without Write syncs happily and refuses the first drag, and no API reports
 * that up front.
 */
const LINEAR_API_KEY_FORM: CredentialForm = {
  createUrl: 'https://linear.app/settings/account/security',
  createLabel: 'Linear → Settings → Security & access',
  fields: [
    {
      key: 'apiKey',
      label: 'Personal API key',
      kind: 'secret',
      placeholder: 'lin_api_…',
      help:
        'Create one under Personal API keys. Give it Read to mirror a team onto a ' +
        'board, or Read and Write if you also want dragging a card here to move the ' +
        'issue in Linear.',
    },
  ],
}

/**
 * Prove the key works and say whose workspace it opens.
 *
 * `VIEWER_QUERY` is the cheapest call that answers both, and it is the same one
 * the OAuth exchange makes — so a connection made either way carries the same
 * `externalAccountId` and `externalTenantId`, and the identity links keyed on
 * them keep working when a workspace moves from one method to the other.
 *
 * `scopes` stays empty deliberately: Linear does not report a key's scopes, and
 * inventing `['read', 'write']` here would be a claim nothing checked. The
 * first refused write is what discovers it, through `SourceRejectedError`.
 */
const verifyLinearApiKey = async (values: Record<string, string>): Promise<ConnectResult> => {
  const apiKey = (values.apiKey ?? '').trim()
  if (!apiKey) {
    throw new SourceCredentialRejectedError('LINEAR_KEY_MISSING', 'Paste your Linear API key')
  }

  let viewer: {
    viewer: { id: string; name: string; email: string }
    organization: { id: string; name: string; urlKey: string }
  }
  try {
    viewer = await linearGraphQl(apiKey, VIEWER_QUERY)
  } catch {
    // Linear answers a bad key with an authentication error inside a 200, which
    // `linearGraphQl` turns into a throw. Either way the person's remedy is the
    // same one sentence, and the vendor's own wording ("Authentication failed")
    // tells them nothing they can act on.
    throw new SourceCredentialRejectedError(
      'LINEAR_KEY_REJECTED',
      'Linear did not accept that key. Check you copied all of it, and that it has not been revoked.',
    )
  }

  return {
    externalAccountId: viewer.viewer.id,
    externalTenantId: viewer.organization.id,
    credential: { accessToken: apiKey, scopes: [] },
    grantedScopes: [],
  }
}

/**
 * Linear as a board source.
 *
 * Deliberately the vendor's own GraphQL API rather than the curated Linear MCP
 * server: an MCP OAuth token is resource-bound to `mcp.linear.app` (RFC 8707)
 * and is not accepted by `api.linear.app`, and MCP has no cursors and no
 * webhooks. The MCP connector keeps its own job — an agent talking to Linear in
 * a run — and this keeps a board fresh. Design §5.2.
 */
export const createLinearAdapter = (config: LinearAdapterConfig): BoardSourceAdapter => {
  const gql: LinearGraphQl = config.graphQl ?? linearGraphQl
  return {
    provider: 'linear',

    // Webhooks are the fast path; this is the floor, so a missed delivery costs
    // freshness rather than correctness.
    incrementalPollingIntervalMs: 5 * 60 * 1000,

    allowedHosts: LINEAR_ALLOWED_HOSTS,

    assetHosts: LINEAR_ASSET_HOSTS,

    auth: {
      ...buildOAuthMethod(config),

      apiKey: {
        form: LINEAR_API_KEY_FORM,
        verify: verifyLinearApiKey,
      },
    },

    listContainers: async (ctx: ConnectionContext): Promise<ContainerDescriptor[]> => {
      const containers: ContainerDescriptor[] = []
      let after: string | undefined
      do {
        const page = await gql<{
          teams: {
            nodes: { id: string; key: string; name: string }[]
            pageInfo: { hasNextPage: boolean; endCursor: string | null }
          }
        }>(ctx.credential.accessToken, TEAMS_QUERY, after ? { after } : {})
        for (const team of page.teams.nodes) {
          containers.push({
            key: team.id,
            container: { teamId: team.id, teamKey: team.key },
            label: team.name,
            hint: team.key,
          })
        }
        after = page.teams.pageInfo.hasNextPage
          ? page.teams.pageInfo.endCursor ?? undefined
          : undefined
      } while (after)
      return containers
    },

    describeContainer: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
    ): Promise<ContainerDescription> => {
      const teamId = String(container.teamId ?? '')
      const data = await gql<{
        team: {
          states: { nodes: { id: string; name: string; type: string; position: number }[] }
          members: { nodes: { id: string; name: string; email: string | null; active: boolean }[] }
          labels: { nodes: LinearLabel[] }
        } | null
      }>(ctx.credential.accessToken, TEAM_DESCRIPTION_QUERY, { teamId })
      if (!data.team) throw new SourceContainerGoneError('That Linear team is no longer reachable')
      // A team's issues may carry workspace labels as well as the team's own.
      const workspace = await gql<{ issueLabels: { nodes: LinearLabel[] } }>(
        ctx.credential.accessToken,
        WORKSPACE_LABELS_QUERY,
      )
      const labels = new Map<string, NormalisedItemLabel>()
      for (const label of [...data.team.labels.nodes, ...workspace.issueLabels.nodes]) {
        labels.set(label.id, normaliseLinearLabel(label))
      }

      return {
        states: [...data.team.states.nodes]
          .sort((a, b) => a.position - b.position)
          .map((state) => ({
            id: state.id,
            name: state.name,
            suggestedCategory: linearStateCategory(state.type),
          })),
        // Labels are first-class (`labels` below), so they are no longer a
        // custom field the attach would create a *Labels* definition for.
        fields: [{ key: 'estimate', label: 'Estimate', type: 'number' }],
        labels: [...labels.values()],
        members: data.team.members.nodes
          .filter((member) => member.active)
          .map((member) => ({
            externalUserId: member.id,
            displayName: member.name,
            ...(member.email ? { email: member.email } : {}),
          })),
      }
    },

    /**
     * Two lanes over one checkpoint. Lane `items` pages issues exactly as it
     * always did; when it runs out it hands over to lane `comments`, which pages
     * the team's comments flat on their own clock and, on its last page, hands
     * back. The worker loops until `hasMore` is false and persists the
     * checkpoint after every page, so it needs to know nothing about lanes.
     */
    fetchPage: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      checkpoint: SyncCheckpoint,
      options: { syncWindowDays: number },
    ): Promise<SyncPage> =>
      checkpoint.lane === 'comments'
        ? fetchCommentsLane(gql, ctx, container, checkpoint)
        : fetchIssuesLane(gql, ctx, container, checkpoint, options),

    fetchItems: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      externalIds: string[],
    ): Promise<NormalisedItem[]> => {
      if (externalIds.length === 0) return []
      const data = await gql<{ issues: { nodes: LinearIssue[] } }>(
        ctx.credential.accessToken,
        ISSUES_BY_ID_QUERY,
        { ids: externalIds.slice(0, 100), teamId: String(container.teamId ?? '') },
      )
      return data.issues.nodes.map(normaliseLinearIssue)
    },

    searchItems: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      query: RemoteItemQuery,
    ): Promise<NormalisedItem[]> => {
      const teamId = String(container.teamId ?? '')
      const data = await gql<{ searchIssues: { nodes: LinearIssue[] } }>(
        ctx.credential.accessToken,
        ISSUE_SEARCH_QUERY,
        { term: query.text, teamId, first: Math.min(query.limit, 50) },
      )
      return data.searchIssues.nodes.map(normaliseLinearIssue)
    },

    /**
     * Ask Linear to call this deployment when the team's issues change.
     *
     * An app-level webhook is the other way in, but it exists only where the
     * deployment registered an OAuth app *and* configured one on it — which no
     * install gets for free, and none at all gets for a pasted API key. So the
     * source registers its own, and the deployment needs nothing configured to
     * have a board that updates in seconds instead of five minutes.
     *
     * Linear only lets a workspace admin (or an OAuth grant carrying `admin`,
     * which this adapter's `read,write` does not ask for) manage webhooks. That
     * refusal is the expected answer for an ordinary member's key, not a fault,
     * so it returns null and the declared poll stays the story.
     */
    ensureWebhook: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      callback: { url: string },
    ): Promise<WebhookRegistration | null> => {
      let data: { webhookCreate: { success: boolean; webhook: LinearWebhook | null } }
      try {
        data = await gql(ctx.credential.accessToken, WEBHOOK_CREATE_MUTATION, {
          input: buildWebhookCreateInput(container, callback),
        })
      } catch (cause) {
        if (isWebhookRegistrationRefused(cause)) return null
        throw cause
      }
      const webhook = data.webhookCreate.webhook
      if (!data.webhookCreate.success || !webhook) return null
      return {
        externalId: webhook.id,
        // Linear webhooks do not expire; a disabled one is the workspace's own
        // decision, and re-creating it behind their back would be wrong.
        expiresAt: null,
        // Handed over exactly once. Nothing reads it back, so a caller that does
        // not persist it has silently downgraded itself to polling.
        ...(webhook.secret ? { signingSecret: webhook.secret } : {}),
      }
    },

    removeWebhook: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      externalId: string,
    ): Promise<void> => {
      await gql(ctx.credential.accessToken, WEBHOOK_DELETE_MUTATION, {
        id: externalId,
      })
    },

    verifyWebhook: (request: WebhookRequest, secrets: WebhookSecrets): boolean => {
      const signature = request.headers['linear-signature']
      const secret = secrets.signingSecret ?? config.webhookSecret
      if (!signature || !secret) return false
      if (!secureEquals(signature, hmacHex('sha256', secret, request.rawBody))) return false

      // Replay window: Linear stamps the payload, and a delivery older than a
      // minute is a replay rather than a slow network.
      try {
        const parsed = JSON.parse(request.rawBody) as { webhookTimestamp?: number }
        if (typeof parsed.webhookTimestamp === 'number') {
          return Math.abs(Date.now() - parsed.webhookTimestamp) <= 60_000
        }
      } catch {
        return false
      }
      return true
    },

    parseWebhook: (request: WebhookRequest): WebhookDelivery => parseLinearWebhook(request),

    applyChange: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      item: { externalId: string; externalKey: string },
      change: OutboundChange,
    ): Promise<NormalisedItem> => {
      const input: Record<string, unknown> = {}
      if (change.stateId !== undefined) input.stateId = change.stateId
      if (change.title !== undefined) input.title = change.title
      if (change.description !== undefined) input.description = change.description
      if (change.assigneeExternalUserId !== undefined) {
        input.assigneeId = change.assigneeExternalUserId
      }
      if (change.dueDate !== undefined) input.dueDate = change.dueDate
      if (change.priority !== undefined) {
        input.priority = LINEAR_PRIORITY_NUMBERS[change.priority ?? 'none'] ?? 0
      }
      if (change.fields?.estimate !== undefined) input.estimate = change.fields.estimate
      if (change.labelIds !== undefined) input.labelIds = change.labelIds

      if (Object.keys(input).length === 0) {
        throw new SourceRejectedError('NOTHING_TO_APPLY', 'No mapped field changed')
      }

      const data = await gql<{
        issueUpdate: { success: boolean; issue: LinearIssue | null }
      }>(ctx.credential.accessToken, ISSUE_UPDATE_MUTATION, { id: item.externalId, input })

      if (!data.issueUpdate.success || !data.issueUpdate.issue) {
        throw new SourceRejectedError(
          'LINEAR_UPDATE_REFUSED',
          `Linear refused the change to ${item.externalKey}`,
        )
      }
      return normaliseLinearIssue(data.issueUpdate.issue)
    },

    /**
     * Linear's uploads are private and read with the same credential the API
     * takes, as the `authorization` header. Streamed, never buffered, under the
     * envelope's 25 MiB cap; a 404 is "gone upstream", which is a different
     * answer from a failure and is reported as one.
     */
    fetchAsset: async (ctx: ConnectionContext, asset: { url: string }): Promise<AssetStream | null> => {
      try {
        const response = await sourceFetchStream({
          url: asset.url,
          allowedHosts: LINEAR_ASSET_HOSTS,
          headers: { authorization: ctx.credential.accessToken },
        })
        return {
          stream: response.stream,
          contentType: response.contentType,
          sizeBytes: response.sizeBytes,
        }
      } catch (cause) {
        if (cause instanceof SourceHttpError && cause.status === 404) return null
        throw cause
      }
    },

    createComment: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      item: { externalId: string; externalKey: string },
      body: string,
    ): Promise<NormalisedComment> => {
      const data = await gql<{
        commentCreate: { success: boolean; comment: LinearComment | null }
      }>(ctx.credential.accessToken, COMMENT_CREATE_MUTATION, {
        input: { issueId: item.externalId, body },
      })
      if (!data.commentCreate.success || !data.commentCreate.comment) {
        throw new SourceRejectedError(
          'LINEAR_COMMENT_REFUSED',
          `Linear refused the comment on ${item.externalKey}`,
        )
      }
      return normaliseLinearComment(data.commentCreate.comment, item.externalId)
    },

    updateComment: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      comment: { externalId: string },
      body: string,
    ): Promise<NormalisedComment> => {
      const data = await gql<{
        commentUpdate: { success: boolean; comment: LinearComment | null }
      }>(ctx.credential.accessToken, COMMENT_UPDATE_MUTATION, {
        id: comment.externalId,
        input: { body },
      })
      if (!data.commentUpdate.success || !data.commentUpdate.comment) {
        throw new SourceRejectedError('LINEAR_COMMENT_REFUSED', 'Linear refused the comment edit')
      }
      return normaliseLinearComment(data.commentUpdate.comment)
    },

    deleteComment: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      comment: { externalId: string },
    ): Promise<void> => {
      const data = await gql<{ commentDelete: { success: boolean } }>(
        ctx.credential.accessToken,
        COMMENT_DELETE_MUTATION,
        { id: comment.externalId },
      )
      if (!data.commentDelete.success) {
        throw new SourceRejectedError('LINEAR_COMMENT_REFUSED', 'Linear refused the comment deletion')
      }
    },
  }
}

type LinearWebhook = { id: string; enabled: boolean; secret?: string | null }

/**
 * What `webhookCreate` is asked for: this team's issues, their comments and
 * their labels, at this URL.
 *
 * `Comment` because the mirror now carries comments (and a deletion only ever
 * arrives this way — polling cannot see an absence); `IssueLabel` because a
 * rename or recolour upstream changes no issue, so without it a pill would
 * keep its old colour until the next describe.
 */
export const buildWebhookCreateInput = (
  container: Record<string, unknown>,
  callback: { url: string },
): Record<string, unknown> => ({
  url: callback.url,
  teamId: String(container.teamId ?? ''),
  resourceTypes: ['Issue', 'Comment', 'IssueLabel'],
  enabled: true,
  label: 'Nessie board source',
})

/**
 * Whether Linear said no, as opposed to something breaking on the way there.
 *
 * Only a workspace admin may manage webhooks, so an ordinary member's key being
 * refused is the *common* case, not a fault — marking the source
 * `misconfigured` for it would alert every such install about a board that is
 * syncing perfectly well on its five-minute poll. A refusal arrives either
 * inside a 200 (Linear's GraphQL errors, which `linearGraphQl` raises as
 * `SourceHttpError`) or as a 401/403; anything else — a timeout, a DNS
 * failure — is a real fault and is left to propagate.
 */
export const isWebhookRegistrationRefused = (cause: unknown): boolean =>
  cause instanceof SourceHttpError || cause instanceof SourceAuthError

/** The reverse of `LINEAR_PRIORITY_TOKENS`, for write-back. */
const LINEAR_PRIORITY_NUMBERS: Record<string, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
}
