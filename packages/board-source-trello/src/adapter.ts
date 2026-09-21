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
  type OutboundChange,
  type RemoteItemQuery,
  SourceContainerGoneError,
  SourceHttpError,
  type SyncCheckpoint,
  type SyncPage,
  type WebhookDelivery,
  type WebhookRegistration,
  type WebhookRequest,
  type WebhookSecrets,
  hmacBase64,
  secureEquals,
} from '@nessie/board-sources'

import {
  ATTACHMENT_FIELDS,
  CARD_FIELDS,
  TRELLO_ALLOWED_HOSTS,
  TRELLO_API_HOST,
  TRELLO_WEB_HOST,
  type TrelloTransport,
  defaultTrelloTransport,
} from './http.js'
import { fetchCardsLane, fetchCommentsLane } from './lanes.js'
import {
  type TrelloCard,
  type TrelloCommentAction,
  type TrelloLabel,
  type TrelloList,
  isTrelloUploadUrl,
  normaliseTrelloCard,
  normaliseTrelloComment,
  normaliseTrelloLabel,
  trelloListCategory,
} from './normalise.js'
import { parseTrelloWebhook } from './webhook-parse.js'

export { TRELLO_ALLOWED_HOSTS, TRELLO_API_HOST, TRELLO_WEB_HOST } from './http.js'

export type TrelloAdapterConfig = {
  apiKey: string
  apiSecret: string
  /** Recorded answers in tests; production never sets it. */
  transport?: Partial<TrelloTransport>
}

/** How many of a card's comments the webhook path's re-read brings. */
const CARD_COMMENTS_LIMIT = 50

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
  const http: TrelloTransport = { ...defaultTrelloTransport, ...config.transport }
  const auth = (ctx: ConnectionContext): string =>
    `key=${encodeURIComponent(config.apiKey)}&token=${encodeURIComponent(ctx.credential.accessToken)}`

  const listsFor = async (
    ctx: ConnectionContext,
    boardId: string,
  ): Promise<TrelloList[]> =>
    http.json<TrelloList[]>({
      url: `https://${TRELLO_API_HOST}/1/boards/${boardId}/lists?${auth(ctx)}`,
      allowedHosts: TRELLO_ALLOWED_HOSTS,
    })

  return {
    provider: 'trello',
    // Cards have no `since`, so polling is the only complete mechanism and the
    // webhook is the nudge rather than the source of truth.
    incrementalPollingIntervalMs: 5 * 60 * 1000,
    allowedHosts: TRELLO_ALLOWED_HOSTS,

    // No `assetHosts`, deliberately. The shared inline scanner sees hosts, not
    // paths, and `trello.com` is mostly card links — declaring it would turn
    // every card linked from a comment into a "file" to download. Trello
    // attaches a pasted image to the card, so the card's own attachment list
    // (and this adapter's path-aware scan) already carries them.

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
          const me = await http.json<{ id: string; username: string }>({
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
      const boards = await http.json<
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

      const members = await http.json<{ id: string; fullName: string; username: string }[]>({
        url: `https://${TRELLO_API_HOST}/1/boards/${boardId}/members?${auth(ctx)}`,
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      }).catch(() => [])
      const labels = await http.json<TrelloLabel[]>({
        url: `https://${TRELLO_API_HOST}/1/boards/${boardId}/labels?fields=id,name,color&limit=1000&${auth(ctx)}`,
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })

      return {
        states: open.map((list, index) => ({
          id: list.id,
          name: list.name,
          suggestedCategory: trelloListCategory(index, open.length),
        })),
        // Labels are first-class (`labels` below), so they are no longer a
        // custom field the attach would create a *Labels* definition for.
        fields: [],
        labels: labels.map(normaliseTrelloLabel),
        // Trello never exposes a member's email, so every mapping here is
        // manual by construction.
        members: members.map((member) => ({
          externalUserId: member.id,
          displayName: member.fullName || member.username,
        })),
      }
    },

    /**
     * Two lanes over one checkpoint: the board's cards, then its comments
     * flat on their own clock. The worker loops until `hasMore` is false.
     */
    fetchPage: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      checkpoint: SyncCheckpoint,
    ): Promise<SyncPage> => {
      const boardId = String(container.boardId ?? '')
      const deps = { http, auth: auth(ctx), boardId }
      return checkpoint.lane === 'comments'
        ? fetchCommentsLane(deps, checkpoint)
        : fetchCardsLane(deps, await listsFor(ctx, boardId), checkpoint)
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
          http.json<TrelloCard>({
            // The webhook path: the card with its files and its newest comments.
            url:
              `https://${TRELLO_API_HOST}/1/cards/${cardId}?fields=${CARD_FIELDS}` +
              `&attachments=true&attachment_fields=${ATTACHMENT_FIELDS}` +
              `&actions=commentCard&actions_limit=${CARD_COMMENTS_LIMIT}` +
              `&action_memberCreator_fields=fullName,username&${auth(ctx)}`,
            allowedHosts: TRELLO_ALLOWED_HOSTS,
          }).catch(() => null),
        ),
      )
      return cards
        .filter((card): card is TrelloCard => card !== null)
        .map((card) => normaliseTrelloCard(card, listNames))
    },

    searchItems: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      query: RemoteItemQuery,
    ): Promise<NormalisedItem[]> => {
      const boardId = String(container.boardId ?? '')
      const lists = await listsFor(ctx, boardId)
      const listNames = new Map(lists.map((list) => [list.id, list.name]))
      // `idBoards` is what keeps this inside the board the source attached —
      // Trello's search would otherwise range over every board the token can
      // reach, which is the whole member's account.
      const url =
        `https://${TRELLO_API_HOST}/1/search?${auth(ctx)}` +
        `&query=${encodeURIComponent(query.text)}` +
        `&idBoards=${encodeURIComponent(boardId)}` +
        `&modelTypes=cards&card_fields=all&cards_limit=${Math.min(query.limit, 100)}`
      const found = await http.json<{ cards?: TrelloCard[] }>({
        url,
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })
      return (found.cards ?? []).map((card) => normaliseTrelloCard(card, listNames))
    },

    ensureWebhook: async (
      ctx: ConnectionContext,
      container: Record<string, unknown>,
      callback: { url: string },
    ): Promise<WebhookRegistration | null> => {
      // Trello proves the callback with a HEAD before it will register, which
      // the intake route answers 200 unconditionally.
      const created = await http.json<{ id: string }>({
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

    parseWebhook: (request: WebhookRequest): WebhookDelivery => parseTrelloWebhook(request),

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
      if (change.labelIds !== undefined) params.set('idLabels', change.labelIds.join(','))

      const echo = await http.json<TrelloCard>({
        url: `https://${TRELLO_API_HOST}/1/cards/${item.externalId}?${auth(ctx)}&${params.toString()}`,
        method: 'PUT',
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })
      const lists = await listsFor(ctx, String(container.boardId ?? ''))
      return normaliseTrelloCard(echo, new Map(lists.map((list) => [list.id, list.name])))
    },

    /**
     * A Trello upload. Trello reads the credential for a download from an
     * `Authorization: OAuth …` header, never from the query, so the token is
     * not written into a URL on this path. The download is asked of the API
     * host, the path Trello documents for it; a redirect is not followed with
     * the credential attached and is recorded as the file's failure.
     */
    fetchAsset: async (ctx: ConnectionContext, asset: { url: string }): Promise<AssetStream | null> => {
      if (!isTrelloUploadUrl(asset.url)) return null
      const url = new URL(asset.url)
      url.hostname = TRELLO_API_HOST
      try {
        const response = await http.stream({
          url: url.toString(),
          allowedHosts: TRELLO_ALLOWED_HOSTS,
          headers: {
            authorization: `OAuth oauth_consumer_key="${config.apiKey}", oauth_token="${ctx.credential.accessToken}"`,
          },
        })
        if (response.status >= 300) {
          response.stream.destroy()
          throw new SourceHttpError(response.status, 'Trello answered the file with a redirect')
        }
        return { stream: response.stream, contentType: response.contentType, sizeBytes: response.sizeBytes }
      } catch (cause) {
        if (cause instanceof SourceHttpError && cause.status === 404) return null
        throw cause
      }
    },

    createComment: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      item: { externalId: string },
      body: string,
    ): Promise<NormalisedComment> => {
      const echo = await http.json<TrelloCommentAction>({
        url: `https://${TRELLO_API_HOST}/1/cards/${encodeURIComponent(item.externalId)}/actions/comments?${auth(ctx)}`,
        method: 'POST',
        allowedHosts: TRELLO_ALLOWED_HOSTS,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      })
      return normaliseTrelloComment(echo, item.externalId)
    },

    updateComment: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      comment: { externalId: string },
      body: string,
    ): Promise<NormalisedComment> => {
      const echo = await http.json<TrelloCommentAction>({
        url: `https://${TRELLO_API_HOST}/1/actions/${encodeURIComponent(comment.externalId)}?${auth(ctx)}`,
        method: 'PUT',
        allowedHosts: TRELLO_ALLOWED_HOSTS,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      })
      return normaliseTrelloComment(echo)
    },

    deleteComment: async (
      ctx: ConnectionContext,
      _container: Record<string, unknown>,
      comment: { externalId: string },
    ): Promise<void> => {
      await http.json({
        url: `https://${TRELLO_API_HOST}/1/actions/${encodeURIComponent(comment.externalId)}?${auth(ctx)}`,
        method: 'DELETE',
        allowedHosts: TRELLO_ALLOWED_HOSTS,
      })
    },
  }
}

/** Exposed so the intake route can hash a callback token the same way. */
export const hashCallbackToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex')
