import { GmailReauthorizationRequiredError } from './errors.js'
import {
  encodeForm,
  requestJson,
  type FetchLike,
  GMAIL_API_BASE,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
} from './http.js'
import type { GmailMessage } from './mime.js'

/** Raw Google OAuth token endpoint response. */
export type TokenResponse = {
  access_token: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  token_type?: string
}

export type GmailProfile = {
  emailAddress: string
  historyId: string
}

export type GmailLabel = {
  id: string
  name?: string
  type?: string
}

export type GmailMessageRef = { id: string; threadId: string }

export type GmailMessagesList = {
  messages?: GmailMessageRef[]
  nextPageToken?: string
}

export type GmailHistoryRecord = {
  id?: string
  messagesAdded?: { message?: GmailMessageRef & { labelIds?: string[] } }[]
  messagesDeleted?: { message?: GmailMessageRef }[]
}

export type GmailHistoryList = {
  history?: GmailHistoryRecord[]
  nextPageToken?: string
  historyId?: string
}

export type GmailWatchResponse = {
  historyId?: string
  expiration?: string
}

const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
})

const withQuery = (path: string, params: Record<string, string>): string => {
  const query = encodeForm(params)
  return query.length > 0 ? `${path}?${query}` : path
}

/** Config a {@link GmailClient} needs, all injected — the package reads no env. */
export type GmailClientConfig = {
  fetchImpl: FetchLike
  clientId: string
  clientSecret?: string
}

/**
 * A thin typed wrapper over the fixed Google OAuth + Gmail REST endpoints. It
 * owns request shaping and JSON parsing only; retry/fatal classification lives
 * in {@link requestJson}. No method logs token material.
 */
export class GmailClient {
  private readonly fetchImpl: FetchLike

  private readonly clientId: string

  private readonly clientSecret?: string

  constructor(config: GmailClientConfig) {
    this.fetchImpl = config.fetchImpl
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
  }

  private form(fields: Record<string, string>): {
    method: string
    headers: Record<string, string>
    body: string
  } {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: encodeForm(fields),
    }
  }

  /** Exchange an authorization code (+ PKCE verifier) for a token bundle. */
  async exchangeCode(params: {
    code: string
    redirectUri: string
    codeVerifier?: string
  }): Promise<TokenResponse> {
    const fields: Record<string, string> = {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: this.clientId,
    }
    if (this.clientSecret) {
      fields.client_secret = this.clientSecret
    }
    if (params.codeVerifier) {
      fields.code_verifier = params.codeVerifier
    }
    const { body } = await requestJson(
      this.fetchImpl,
      'token.exchange',
      GOOGLE_TOKEN_URL,
      this.form(fields),
    )
    return body as TokenResponse
  }

  /** Refresh an access token; `invalid_grant` becomes a reauthorization signal. */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    const fields: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
    }
    if (this.clientSecret) {
      fields.client_secret = this.clientSecret
    }
    try {
      const { body } = await requestJson(
        this.fetchImpl,
        'token.refresh',
        GOOGLE_TOKEN_URL,
        this.form(fields),
      )
      return body as TokenResponse
    } catch (error) {
      if (isInvalidGrant(error)) {
        throw new GmailReauthorizationRequiredError('invalid_grant')
      }
      throw error
    }
  }

  /** Revoke a token; already-revoked (400) is tolerated by the caller. */
  async revoke(token: string): Promise<void> {
    await requestJson(this.fetchImpl, 'token.revoke', GOOGLE_REVOKE_URL, {
      ...this.form({ token }),
      notFoundOk: true,
    })
  }

  async getProfile(accessToken: string): Promise<GmailProfile> {
    const { body } = await requestJson(
      this.fetchImpl,
      'users.getProfile',
      `${GMAIL_API_BASE}/profile`,
      { headers: bearer(accessToken) },
    )
    return body as GmailProfile
  }

  async listLabels(accessToken: string): Promise<GmailLabel[]> {
    const { body } = await requestJson(
      this.fetchImpl,
      'users.labels.list',
      `${GMAIL_API_BASE}/labels`,
      { headers: bearer(accessToken) },
    )
    return (body as { labels?: GmailLabel[] }).labels ?? []
  }

  async listMessages(
    accessToken: string,
    params: { q?: string; pageToken?: string; maxResults: number },
  ): Promise<GmailMessagesList> {
    const query: Record<string, string> = { maxResults: String(params.maxResults) }
    if (params.q) {
      query.q = params.q
    }
    if (params.pageToken) {
      query.pageToken = params.pageToken
    }
    const { body } = await requestJson(
      this.fetchImpl,
      'users.messages.list',
      withQuery(`${GMAIL_API_BASE}/messages`, query),
      { headers: bearer(accessToken) },
    )
    return body as GmailMessagesList
  }

  async getMessage(accessToken: string, id: string): Promise<GmailMessage> {
    const { body } = await requestJson(
      this.fetchImpl,
      'users.messages.get',
      withQuery(`${GMAIL_API_BASE}/messages/${encodeURIComponent(id)}`, {
        format: 'full',
      }),
      { headers: bearer(accessToken) },
    )
    return body as GmailMessage
  }

  /** List history since `startHistoryId`; a 404 (expired) returns `null`. */
  async listHistory(
    accessToken: string,
    params: { startHistoryId: string; pageToken?: string },
  ): Promise<GmailHistoryList | null> {
    const query: Record<string, string> = { startHistoryId: params.startHistoryId }
    if (params.pageToken) {
      query.pageToken = params.pageToken
    }
    const { status, body } = await requestJson(
      this.fetchImpl,
      'users.history.list',
      withQuery(`${GMAIL_API_BASE}/history`, query),
      { headers: bearer(accessToken), notFoundOk: true },
    )
    if (status === 404) {
      return null
    }
    return body as GmailHistoryList
  }

  async watch(
    accessToken: string,
    params: { topicName: string },
  ): Promise<GmailWatchResponse> {
    const { body } = await requestJson(
      this.fetchImpl,
      'users.watch',
      `${GMAIL_API_BASE}/watch`,
      {
        method: 'POST',
        headers: { ...bearer(accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ topicName: params.topicName }),
      },
    )
    return body as GmailWatchResponse
  }

  async stop(accessToken: string): Promise<void> {
    await requestJson(this.fetchImpl, 'users.stop', `${GMAIL_API_BASE}/stop`, {
      method: 'POST',
      headers: bearer(accessToken),
      notFoundOk: true,
    })
  }
}

const isInvalidGrant = (error: unknown): boolean =>
  error !== null
  && typeof error === 'object'
  && 'reason' in error
  && (error as { reason?: unknown }).reason === 'invalid_grant'
