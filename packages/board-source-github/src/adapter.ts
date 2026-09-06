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
  hmacHex,
  secureEquals,
  sourceFetchJson,
} from '@nessie/board-sources'

import {
  GITHUB_ISSUE_STATES,
  type GitHubIssue,
  type ProjectV2Item,
  normaliseGitHubIssue,
  normaliseProjectItem,
} from './normalise.js'
import { PROJECT_ITEMS_QUERY, PROJECT_STATUS_QUERY, VIEWER_PROJECTS_QUERY } from './queries.js'

export const GITHUB_API_HOST = 'api.github.com'
export const GITHUB_WEB_HOST = 'github.com'
export const GITHUB_ALLOWED_HOSTS = [GITHUB_API_HOST, GITHUB_WEB_HOST] as const

export type GitHubAdapterConfig = {
  clientId: string
  clientSecret: string
  webhookSecret?: string
}

const restHeaders = (ctx: ConnectionContext): Record<string, string> => ({
  authorization: `Bearer ${ctx.credential.accessToken}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'nessie-board-source',
})

const graphql = async <T>(
  ctx: ConnectionContext,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  const payload = await sourceFetchJson<{ data?: T; errors?: { message: string }[] }>({
    url: `https://${GITHUB_API_HOST}/graphql`,
    method: 'POST',
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: { ...restHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (payload.errors?.length) {
    throw new SourceRejectedError('GITHUB_GRAPHQL_ERROR', payload.errors[0]?.message ?? 'refused')
  }
  if (!payload.data) throw new SourceContainerGoneError('GitHub answered with no data')
  return payload.data
}

const isRepository = (container: Record<string, unknown>): boolean =>
  container.kind === 'repository'

/**
 * GitHub as a board source, in two shapes.
 *
 * A **repository** contributes its issues, whose only states are open and
 * closed — there is no in-progress and no review, which is why an Issues board
 * maps to three states rather than four and why a person binds a label or a
 * Projects status if they want more.
 *
 * A **Projects v2 board** contributes its items, whose state is the `Status`
 * single-select and whose other fields map 1:1 onto custom fields. It is
 * GraphQL-only; there is no REST equivalent.
 */
export const createGitHubAdapter = (config: GitHubAdapterConfig): BoardSourceAdapter => ({
  provider: 'github',
  incrementalPollingIntervalMs: 5 * 60 * 1000,
  allowedHosts: GITHUB_ALLOWED_HOSTS,

  auth: {
    oauth: {
      buildAuthorizeUrl: ({ state, redirectUri }) => {
        const url = new URL(`https://${GITHUB_WEB_HOST}/login/oauth/authorize`)
        url.searchParams.set('client_id', config.clientId)
        url.searchParams.set('redirect_uri', redirectUri)
        url.searchParams.set('state', state)
        url.searchParams.set('scope', 'repo read:project read:org')
        return url.toString()
      },

      exchange: async ({ code, redirectUri }: OAuthExchangeInput): Promise<ConnectResult> => {
        const token = await sourceFetchJson<{
          access_token: string
          refresh_token?: string
          expires_in?: number
          scope?: string
        }>({
          url: `https://${GITHUB_WEB_HOST}/login/oauth/access_token`,
          method: 'POST',
          allowedHosts: GITHUB_ALLOWED_HOSTS,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        })
        const scopes = (token.scope ?? '').split(/[\s,]+/).filter(Boolean)
        const me = await sourceFetchJson<{ id: number; login: string }>({
          url: `https://${GITHUB_API_HOST}/user`,
          allowedHosts: GITHUB_ALLOWED_HOSTS,
          headers: {
            authorization: `Bearer ${token.access_token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'nessie-board-source',
          },
        })
        return {
          externalAccountId: String(me.id),
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
        // A classic OAuth token does not expire; only a GitHub App's
        // user-to-server token does, and only that one carries a refresh token.
        if (!credential.refreshToken) return credential
        const token = await sourceFetchJson<{
          access_token: string
          refresh_token?: string
          expires_in?: number
        }>({
          url: `https://${GITHUB_WEB_HOST}/login/oauth/access_token`,
          method: 'POST',
          allowedHosts: GITHUB_ALLOWED_HOSTS,
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: credential.refreshToken,
          }),
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
  },

  listContainers: async (ctx: ConnectionContext): Promise<ContainerDescriptor[]> => {
    const repositories = await sourceFetchJson<
      { full_name: string; owner: { login: string }; name: string; has_issues: boolean }[]
    >({
      url: `https://${GITHUB_API_HOST}/user/repos?per_page=100&sort=updated`,
      allowedHosts: GITHUB_ALLOWED_HOSTS,
      headers: restHeaders(ctx),
    })

    const containers: ContainerDescriptor[] = repositories
      .filter((repository) => repository.has_issues)
      .map((repository) => ({
        key: `repo:${repository.full_name}`,
        container: {
          kind: 'repository',
          owner: repository.owner.login,
          repo: repository.name,
        },
        label: repository.full_name,
        hint: 'Issues',
      }))

    // Projects v2 has no REST listing at all.
    const projects = await graphql<{
      viewer: {
        projectsV2: { nodes: { id: string; number: number; title: string }[] }
      }
    }>(ctx, VIEWER_PROJECTS_QUERY).catch(() => null)
    for (const project of projects?.viewer.projectsV2.nodes ?? []) {
      containers.push({
        key: `project:${project.id}`,
        container: { kind: 'project', nodeId: project.id, number: project.number },
        label: project.title,
        hint: 'Projects board',
      })
    }
    return containers
  },

  describeContainer: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
  ): Promise<ContainerDescription> => {
    if (isRepository(container)) {
      const owner = String(container.owner ?? '')
      const repo = String(container.repo ?? '')
      const collaborators = await sourceFetchJson<{ id: number; login: string }[]>({
        url: `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/collaborators?per_page=100`,
        allowedHosts: GITHUB_ALLOWED_HOSTS,
        headers: restHeaders(ctx),
      }).catch(() => [])
      return {
        states: GITHUB_ISSUE_STATES,
        fields: [{ key: 'labels', label: 'Labels', type: 'multi_select' }],
        members: collaborators.map((person) => ({
          externalUserId: String(person.id),
          displayName: person.login,
        })),
      }
    }

    const data = await graphql<{
      node: {
        field?: {
          options?: { id: string; name: string }[]
        } | null
        fields?: { nodes: { name?: string; dataType?: string }[] }
      } | null
    }>(ctx, PROJECT_STATUS_QUERY, { projectId: String(container.nodeId ?? '') })
    if (!data.node) throw new SourceContainerGoneError('That project board is not reachable')

    const options = data.node.field?.options ?? []
    return {
      // Order is the board's own: the first column is where work starts and the
      // last is where it ends, which is the only signal a Projects board gives.
      states: options.map((option, index) => ({
        id: option.id,
        name: option.name,
        suggestedCategory:
          index === 0 ? 'todo' : index === options.length - 1 ? 'done' : 'in_progress',
      })),
      fields: (data.node.fields?.nodes ?? [])
        .filter((field) => field.name && field.name !== 'Status')
        .map((field) => ({
          key: field.name as string,
          label: field.name as string,
          type: field.dataType === 'NUMBER' ? 'number' : field.dataType === 'DATE' ? 'date' : 'text',
        })),
      members: [],
    }
  },

  fetchPage: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    checkpoint: SyncCheckpoint,
    options: { syncWindowDays: number },
  ): Promise<SyncPage> => {
    const since =
      checkpoint.since ??
      new Date(Date.now() - options.syncWindowDays * 24 * 60 * 60 * 1000).toISOString()

    if (isRepository(container)) {
      const owner = String(container.owner ?? '')
      const repo = String(container.repo ?? '')
      const page = Number(checkpoint.cursor ?? '1')
      const url = new URL(`https://${GITHUB_API_HOST}/repos/${owner}/${repo}/issues`)
      url.searchParams.set('state', 'all')
      url.searchParams.set('since', since)
      url.searchParams.set('sort', 'updated')
      url.searchParams.set('direction', 'asc')
      url.searchParams.set('per_page', '100')
      url.searchParams.set('page', String(page))

      const rows = await sourceFetchJson<GitHubIssue[]>({
        url: url.toString(),
        allowedHosts: GITHUB_ALLOWED_HOSTS,
        headers: restHeaders(ctx),
      })
      // The issues endpoint returns pull requests too; they are not board work.
      const issues = rows.filter((row) => !row.pull_request)
      const items = issues.map(normaliseGitHubIssue)
      const hasMore = rows.length === 100
      const latest = items.reduce<string | null>(
        (newest, item) => (newest === null || item.updatedAt > newest ? item.updatedAt : newest),
        null,
      )
      return {
        items,
        hasMore,
        checkpoint: hasMore
          ? { phase: checkpoint.phase, since, cursor: String(page + 1) }
          : {
              phase: 'incremental',
              since: latest ? new Date(Date.parse(latest) - 60_000).toISOString() : since,
            },
      }
    }

    const data = await graphql<{
      node: {
        items: {
          nodes: ProjectV2Item[]
          pageInfo: { hasNextPage: boolean; endCursor: string | null }
        }
      } | null
    }>(ctx, PROJECT_ITEMS_QUERY, {
      projectId: String(container.nodeId ?? ''),
      ...(checkpoint.cursor ? { after: checkpoint.cursor } : {}),
    })
    if (!data.node) throw new SourceContainerGoneError('That project board is not reachable')

    const items = data.node.items.nodes
      .map(normaliseProjectItem)
      .filter((item): item is NormalisedItem => item !== null)
    const hasMore = data.node.items.pageInfo.hasNextPage
    return {
      items,
      hasMore,
      checkpoint: hasMore
        ? {
            phase: checkpoint.phase,
            since,
            cursor: data.node.items.pageInfo.endCursor as string,
          }
        : { phase: 'incremental', since: new Date().toISOString() },
    }
  },

  fetchItems: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    externalIds: string[],
  ): Promise<NormalisedItem[]> => {
    if (externalIds.length === 0 || !isRepository(container)) return []
    const owner = String(container.owner ?? '')
    const repo = String(container.repo ?? '')
    const issues = await Promise.all(
      externalIds.slice(0, 20).map((nodeId) =>
        sourceFetchJson<GitHubIssue>({
          url: `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/issues/${nodeId}`,
          allowedHosts: GITHUB_ALLOWED_HOSTS,
          headers: restHeaders(ctx),
        }).catch(() => null),
      ),
    )
    return issues
      .filter((issue): issue is GitHubIssue => issue !== null && !issue.pull_request)
      .map(normaliseGitHubIssue)
  },

  // Webhooks are configured once on the GitHub App and fire for every
  // installation, so there is nothing to register per source.
  ensureWebhook: async (): Promise<WebhookRegistration | null> => null,

  verifyWebhook: (request: WebhookRequest, secrets: WebhookSecrets): boolean => {
    const signature = request.headers['x-hub-signature-256']
    const secret = secrets.signingSecret ?? config.webhookSecret
    if (!signature || !secret) return false
    return secureEquals(signature, `sha256=${hmacHex('sha256', secret, request.rawBody)}`)
  },

  parseWebhook: (request: WebhookRequest): WebhookDelivery => {
    const parsed = JSON.parse(request.rawBody) as {
      issue?: { number?: number; node_id?: string }
      projects_v2_item?: { node_id?: string }
      repository?: { full_name?: string }
    }
    // The issue endpoint is addressed by number, so that is what is carried —
    // `fetchItems` re-reads with it.
    const issueId = parsed.issue?.number
    return {
      // GitHub's own delivery uuid, identical across every redelivery of the
      // same event. Null rather than a clock reading when it is absent: the
      // caller hashes the body, which at least dedupes a retry.
      deliveryId: request.headers['x-github-delivery'] ?? null,
      containerKey: parsed.repository?.full_name
        ? `repo:${parsed.repository.full_name}`
        : parsed.projects_v2_item?.node_id
          ? null
          : null,
      externalIds: issueId ? [String(issueId)] : [],
    }
  },

  applyChange: async (
    ctx: ConnectionContext,
    container: Record<string, unknown>,
    item: { externalId: string; externalKey: string },
    change: OutboundChange,
  ): Promise<NormalisedItem> => {
    if (!isRepository(container)) {
      throw new SourceRejectedError(
        'GITHUB_PROJECT_READ_ONLY',
        'Writing back to a GitHub Projects board is not supported yet — change it in GitHub.',
      )
    }
    const owner = String(container.owner ?? '')
    const repo = String(container.repo ?? '')
    const number = item.externalKey.replace('#', '')

    const body: Record<string, unknown> = {}
    if (change.title !== undefined) body.title = change.title
    if (change.description !== undefined) body.body = change.description
    if (change.stateId !== undefined) {
      body.state = change.stateId === 'open' ? 'open' : 'closed'
      if (change.stateId === 'closed:not_planned') body.state_reason = 'not_planned'
      if (change.stateId === 'closed:completed') body.state_reason = 'completed'
    }
    if (change.assigneeExternalUserId !== undefined) {
      // GitHub assigns by login, and the id is what identity links store, so
      // the login is resolved rather than guessed from a display name.
      const login = change.assigneeExternalUserId
        ? (
            await sourceFetchJson<{ login: string }>({
              url: `https://${GITHUB_API_HOST}/user/${change.assigneeExternalUserId}`,
              allowedHosts: GITHUB_ALLOWED_HOSTS,
              headers: restHeaders(ctx),
            })
          ).login
        : null
      body.assignees = login ? [login] : []
    }

    const echo = await sourceFetchJson<GitHubIssue>({
      url: `https://${GITHUB_API_HOST}/repos/${owner}/${repo}/issues/${number}`,
      method: 'PATCH',
      allowedHosts: GITHUB_ALLOWED_HOSTS,
      headers: { ...restHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return normaliseGitHubIssue(echo)
  },
})
