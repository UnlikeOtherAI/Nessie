import { createHash } from 'node:crypto'

import {
  type BoardSourceAdapter,
  type ConnectResult,
  type ConnectionContext,
  type ContainerDescription,
  type ContainerDescriptor,
  type CredentialBundle,
  type NormalisedItem,
  type OutboundChange,
  SourceContainerGoneError,
  type SyncCheckpoint,
  type SyncPage,
  type WebhookDelivery,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookSecrets,
  hmacBase64,
  secureEquals,
  sourceFetchJson,
} from '@nessie/board-sources'

import {
  type TrelloCard,
  type TrelloList,
  normaliseTrelloCard,
  trelloListCategory,
} from './normalise.js'

export const TRELLO_API_HOST = 'api.trello.com'
export const TRELLO_WEB_HOST = 'trello.com'
export const TRELLO_ALLOWED_HOSTS = [TRELLO_API_HOST, TRELLO_WEB_HOST] as const

export type TrelloAdapterConfig = { apiKey: string; apiSecret: string }

/**
 * Trello as a board source.
 *
 * Trello is the odd one: its authorization is not OAuth 2 but a token handed to
 * the browser in a URL fragment, so the token is submitted once and encrypted
 * rather than exchanged for one; and its cards have no `since` filter, so an
 * incremental sync re-reads the open cards and compares `dateLastActivity`.
 * That is fine at board scale and honest about what the API offers.
 */
export const createTrelloAdapter = (config: TrelloAdapterConfig): BoardSourceAdapter => {
  const auth = (ctx: ConnectionContext): string =>
    `key=${encodeURIComponent(config.apiKey)}&token=${encodeURIComponent(ctx.credential.accessToken)}`

  const listsFor = async (
    ctx: ConnectionContext,
    boardId: string,
  ): Promise<TrelloList[]> =>
    sourceFetchJson<TrelloList[]>({
      url: `https://${TRELLO_API_HOST}/1/boards/${boardId}/lists?${auth(ctx)}`,
      allowedHosts: TRELLO_ALLOWED_HOSTS,
    })

  return {
    provider: 'trello',
    // Cards have no `since`, so polling is the only complete mechanism and the
    // webhook is the nudge rather than the source of truth.
    incrementalPollingIntervalMs: 5 * 60 * 1000,
    allowedHosts: TRELLO_ALLOWED_HOSTS,

    auth: {
      oauth: {
        buildAuthorizeUrl: ({ state, redirectUri }) => {
          const url = new URL(`https://${TRELLO_WEB_HOST}/1/authorize`)
          url.searchParams.set('key', config.apiKey)
          url.searchParams.set('name', 'Nessie')
          url.searchParams.set('scope', 'read,write')
          url.searchParams.set('expiration', 'never')
          url.searchParams.set('response_type', 'token')
          // Trello returns the token in the fragment, so the callback page reads
          // it client-side and posts it once to `/complete`; `state` rides along
          // so that submission is still bound to this request.
          url.searchParams.set('return_url', `${redirectUri}#state=${state}`)
          return url.toString()
        },

        // There is no code to exchange: `code` carries the token the callback
        // page submitted, and this call proves it by asking who it belongs to.
        exchange: async ({ code }): Promise<ConnectResult> => {
          const me = await sourceFetchJson<{ id: string; username: string }>({
            url: `https://${TRELLO_API_HOST}/1/members/me?key=${encodeURIComponent(config.apiKey)}&token=${encodeURIComponent(code)}`,
            allowedHosts: TRELLO_ALLOWED_HOSTS,
          })
          return {
            externalAccountId: me.id,
            externalTenantId: '',
            credential: { accessToken: code, scopes: ['read', 'write'] },
            grantedScopes: ['read', 'write'],
          }
        },

        // A never-expiring token has nothing to refresh; pretending otherwise
        // would turn a healthy connection into a failing one.
        refresh: async (credential: CredentialBundle): Promise<CredentialBundle> => credential,
      },
    },

    listContainers: async (ctx: ConnectionContext): Promise<ContainerDescriptor[]> => {
      const boards = await sourceFetchJson<
        { id: string; name: string; closed: boolean; url: string }[]
      >({
        url: `https://${TRELLO_API_HOST}/1/members/me/boards?filter=open&fields=name,closed,url&${auth(ctx)}`,
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })
      return boards
        .filter((board) => !board.closed)
        .map((board) => ({
          key: board.id,
          container: { boardId: board.id },
          label: board.name,
          hint: 'Trello board',
        }))
    },

    describeContainer: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
    ): Promise<ContainerDescription> => {
      const boardId = String(container.boardId ?? '')
      let lists: TrelloList[]
      try {
        lists = await listsFor(ctx, boardId)
      } catch {
        throw new SourceContainerGoneError('That Trello board is no longer reachable')
      }
      const open = lists.filter((list) => !list.closed).sort((a, b) => a.pos - b.pos)

      const members = await sourceFetchJson<{ id: string; fullName: string; username: string }[]>({
        url: `https://${TRELLO_API_HOST}/1/boards/${boardId}/members?${auth(ctx)}`,
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      }).catch(() => [])

      return {
        states: open.map((list, index) => ({
          id: list.id,
          name: list.name,
          suggestedCategory: trelloListCategory(index, open.length),
        })),
        fields: [{ key: 'labels', label: 'Labels', type: 'multi_select' }],
        // Trello never exposes a member's email, so every mapping here is
        // manual by construction.
        members: members.map((member) => ({
          externalUserId: member.id,
          displayName: member.fullName || member.username,
        })),
      }
    },

    fetchPage: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      checkpoint: SyncCheckpoint,
    ): Promise<SyncPage> => {
      const boardId = String(container.boardId ?? '')
      const lists = await listsFor(ctx, boardId)
      const listNames = new Map(lists.map((list) => [list.id, list.name]))

      const cards = await sourceFetchJson<TrelloCard[]>({
        url: `https://${TRELLO_API_HOST}/1/boards/${boardId}/cards/all?fields=id,idShort,name,desc,url,closed,idList,idMembers,labels,due,dateLastActivity&${auth(ctx)}`,
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })

      // No `since` on cards: the whole board is read and the checkpoint is used
      // to skip what has not moved since the last pass.
      const since = checkpoint.since
      const items = cards
        .map((card) => normaliseTrelloCard(card, listNames))
        .filter((item) => !since || item.updatedAt > since)

      return {
        items,
        hasMore: false,
        checkpoint: { phase: 'incremental', since: new Date().toISOString() },
      }
    },

    fetchItems: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      externalIds: string[],
    ): Promise<NormalisedItem[]> => {
      if (externalIds.length === 0) return []
      const lists = await listsFor(ctx, String(container.boardId ?? ''))
      const listNames = new Map(lists.map((list) => [list.id, list.name]))
      const cards = await Promise.all(
        externalIds.slice(0, 20).map((cardId) =>
          sourceFetchJson<TrelloCard>({
            url: `https://${TRELLO_API_HOST}/1/cards/${cardId}?${auth(ctx)}`,
            allowedHosts: TRELLO_ALLOWED_HOSTS,
          }).catch(() => null),
        ),
      )
      return cards
        .filter((card): card is TrelloCard => card !== null)
        .map((card) => normaliseTrelloCard(card, listNames))
    },

    ensureWebhook: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      callback: { url: string },
    ): Promise<WebhookRegistration | null> => {
      // Trello proves the callback with a HEAD before it will register, which
      // the intake route answers 200 unconditionally.
      const created = await sourceFetchJson<{ id: string }>({
        url: `https://${TRELLO_API_HOST}/1/webhooks?${auth(ctx)}`,
        method: 'POST',
        allowedHosts: TRELLO_ALLOWED_HOSTS,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callbackURL: callback.url,
          idModel: String(container.boardId ?? ''),
          description: 'Nessie board source',
        }),
      })
      return created.id ? { externalId: created.id, expiresAt: null } : null
    },

    verifyWebhook: (request: WebhookRequest, secrets: WebhookSecrets): boolean => {
      const signature = request.headers['x-trello-webhook']
      const callbackUrl = secrets.callbackUrl
      if (!signature || !callbackUrl) return false
      // Trello signs base64(HMAC-SHA1(body + callbackURL)) with the app secret,
      // so the callback URL is part of the signed material.
      return secureEquals(
        signature,
        hmacBase64('sha1', config.apiSecret, request.rawBody + callbackUrl),
      )
    },

    parseWebhook: (request: WebhookRequest): WebhookDelivery => {
      const parsed = JSON.parse(request.rawBody) as {
        action?: { id?: string; data?: { card?: { id?: string }; board?: { id?: string } } }
      }
      return {
        deliveryId: parsed.action?.id ?? `trello:${Date.now()}`,
        containerKey: parsed.action?.data?.board?.id ?? null,
        externalIds: parsed.action?.data?.card?.id ? [parsed.action.data.card.id] : [],
      }
    },

    applyChange: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      item: { externalId: string },
      change: OutboundChange,
    ): Promise<NormalisedItem> => {
      const params = new URLSearchParams()
      if (change.stateId !== undefined) params.set('idList', change.stateId)
      if (change.title !== undefined) params.set('name', change.title)
      if (change.description !== undefined) params.set('desc', change.description ?? '')
      if (change.dueDate !== undefined) params.set('due', change.dueDate ?? '')
      if (change.assigneeExternalUserId !== undefined) {
        params.set('idMembers', change.assigneeExternalUserId ?? '')
      }

      const echo = await sourceFetchJson<TrelloCard>({
        url: `https://${TRELLO_API_HOST}/1/cards/${item.externalId}?${auth(ctx)}&${params.toString()}`,
        method: 'PUT',
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })
      const lists = await listsFor(ctx, String(container.boardId ?? ''))
      return normaliseTrelloCard(echo, new Map(lists.map((list) => [list.id, list.name])))
    },
  }
}

/** Exposed so the intake route can hash a callback token the same way. */
export const hashCallbackToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
