import {
  assertGraphPageUrl,
  encodeForm,
  MICROSOFT_GRAPH_BASE,
  MICROSOFT_TOKEN_URL,
  requestJson,
  type FetchLike,
} from './http.js'
import {
  MicrosoftApiError,
  MicrosoftReauthorizationRequiredError,
} from './errors.js'

export type MicrosoftTokenResponse = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  id_token?: string
}

export type MicrosoftGraphUser = {
  id?: string
  displayName?: string
  mail?: string | null
  userPrincipalName?: string
}

export type MicrosoftMailFolder = {
  id?: string
  displayName?: string
  wellKnownName?: string
}

export type MicrosoftRecipient = {
  emailAddress?: { address?: string; name?: string }
}

export type MicrosoftMessage = {
  id?: string
  conversationId?: string
  subject?: string
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  from?: MicrosoftRecipient
  toRecipients?: MicrosoftRecipient[]
  ccRecipients?: MicrosoftRecipient[]
  bccRecipients?: MicrosoftRecipient[]
  receivedDateTime?: string
  sentDateTime?: string
  lastModifiedDateTime?: string
  internetMessageId?: string
  '@removed'?: { reason?: string }
}

export type MicrosoftDeltaPage = {
  value?: MicrosoftMessage[]
  '@odata.nextLink'?: string
  '@odata.deltaLink'?: string
}

type MicrosoftFoldersPage = {
  value?: MicrosoftMailFolder[]
  '@odata.nextLink'?: string
}

const bearer = (accessToken: string): Record<string, string> => ({
  authorization: `Bearer ${accessToken}`,
})

const graphQuery = (path: string, values: Record<string, string>): string => {
  const query = new URLSearchParams(values)
  return `${path}?${query.toString()}`
}

const messageSelect = [
  'id',
  'conversationId',
  'subject',
  'bodyPreview',
  'body',
  'from',
  'toRecipients',
  'ccRecipients',
  'bccRecipients',
  'receivedDateTime',
  'sentDateTime',
  'lastModifiedDateTime',
  'internetMessageId',
].join(',')

/** Fixed-host OAuth/Graph client. It shapes requests but never logs payloads. */
export class MicrosoftGraphClient {
  private readonly fetchImpl: FetchLike

  private readonly clientId: string

  private readonly clientSecret?: string

  constructor(input: {
    fetch: FetchLike
    clientId: string
    clientSecret?: string
  }) {
    this.fetchImpl = input.fetch
    this.clientId = input.clientId
    this.clientSecret = input.clientSecret
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

  async exchangeCode(input: {
    code: string
    redirectUri: string
    codeVerifier: string
  }): Promise<MicrosoftTokenResponse> {
    const fields: Record<string, string> = {
      client_id: this.clientId,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    }
    if (this.clientSecret) fields.client_secret = this.clientSecret
    try {
      const { body } = await requestJson(
        this.fetchImpl,
        'token.exchange',
        MICROSOFT_TOKEN_URL,
        this.form(fields),
      )
      return body as MicrosoftTokenResponse
    } catch (error) {
      if (isRejectedGrant(error)) {
        throw new MicrosoftReauthorizationRequiredError(error.code)
      }
      throw error
    }
  }

  async refresh(refreshToken: string): Promise<MicrosoftTokenResponse> {
    const fields: Record<string, string> = {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }
    if (this.clientSecret) fields.client_secret = this.clientSecret
    try {
      const { body } = await requestJson(
        this.fetchImpl,
        'token.refresh',
        MICROSOFT_TOKEN_URL,
        this.form(fields),
      )
      return body as MicrosoftTokenResponse
    } catch (error) {
      if (isRejectedGrant(error)) {
        throw new MicrosoftReauthorizationRequiredError(error.code)
      }
      throw error
    }
  }

  async getMe(accessToken: string): Promise<MicrosoftGraphUser> {
    const { body } = await requestJson(
      this.fetchImpl,
      'me.get',
      graphQuery(`${MICROSOFT_GRAPH_BASE}/me`, {
        '$select': 'id,displayName,mail,userPrincipalName',
      }),
      { headers: bearer(accessToken) },
    )
    return body as MicrosoftGraphUser
  }

  async listMailFolders(
    accessToken: string,
    pageUrl?: string,
  ): Promise<MicrosoftFoldersPage> {
    const url = pageUrl
      ? assertGraphPageUrl(pageUrl)
      : graphQuery(`${MICROSOFT_GRAPH_BASE}/me/mailFolders`, {
          '$select': 'id,displayName,wellKnownName',
          '$top': '100',
          includeHiddenFolders: 'false',
        })
    const { body } = await requestJson(
      this.fetchImpl,
      'mailFolders.list',
      url,
      { headers: bearer(accessToken) },
    )
    return body as MicrosoftFoldersPage
  }

  async getFolderDelta(
    accessToken: string,
    input: { folderId?: string; pageUrl?: string; pageSize: number },
  ): Promise<MicrosoftDeltaPage | null> {
    const url = input.pageUrl
      ? assertGraphPageUrl(input.pageUrl)
      : graphQuery(
          `${MICROSOFT_GRAPH_BASE}/me/mailFolders/${encodeURIComponent(input.folderId ?? '')}`
            + '/messages/delta',
          { '$select': messageSelect, '$top': String(input.pageSize) },
        )
    const { status, body } = await requestJson(
      this.fetchImpl,
      'messages.delta',
      url,
      {
        // Never import provider HTML: the `Prefer` header makes Graph return
        // the body itself as plain text, not merely a different presentation.
        headers: {
          ...bearer(accessToken),
          Prefer: 'outlook.body-content-type="text"',
        },
        goneOk: true,
      },
    )
    if (status === 410) return null
    const page = body as MicrosoftDeltaPage
    return {
      ...page,
      ...(page['@odata.nextLink']
        ? { '@odata.nextLink': assertGraphPageUrl(page['@odata.nextLink']) }
        : {}),
      ...(page['@odata.deltaLink']
        ? { '@odata.deltaLink': assertGraphPageUrl(page['@odata.deltaLink']) }
        : {}),
    }
  }
}

const isRejectedGrant = (error: unknown): error is MicrosoftApiError =>
  error instanceof MicrosoftApiError
  && error.status === 400
  && (error.code === 'invalid_grant' || error.code === 'interaction_required')
