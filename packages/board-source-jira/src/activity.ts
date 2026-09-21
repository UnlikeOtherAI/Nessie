import {
  type AssetStream,
  type ConnectionContext,
  type NormalisedComment,
  SourceHttpError,
  SourceRejectedError,
} from '@nessie/board-sources'

import { markdownToAdf } from './adf.js'
import { JIRA_ALLOWED_HOSTS, type JiraTransport, apiBase, authHeaders } from './http.js'
import {
  JIRA_ASSET_HOSTS,
  type JiraComment,
  type JiraIssue,
  issueIdFromCommentSelf,
  normaliseJiraComment,
} from './normalise.js'

/**
 * Comments and files beyond what a search page carries: the newest comments of
 * a long thread, the comment write-backs and the file fetch.
 */

const containerOf = (container: Record<string, unknown>) => ({
  cloudId: String(container.cloudId ?? ''),
  siteUrl: String(container.siteUrl ?? ''),
})

/**
 * A search embeds only the first page of an issue's comments. On the webhook
 * path — where the comment that changed is usually the newest — an issue whose
 * thread is longer than that is topped up with its newest hundred.
 */
export const topUpComments = async (
  http: JiraTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  issue: JiraIssue,
): Promise<JiraIssue> => {
  const embedded = issue.fields.comment
  const read = embedded?.comments?.length ?? 0
  if (!embedded || (embedded.total ?? read) <= read) return issue
  const { cloudId } = containerOf(container)
  const newest = await http.json<{ comments?: JiraComment[] }>({
    url: `${apiBase(cloudId)}/issue/${issue.id}/comment?orderBy=-created&maxResults=100`,
    allowedHosts: JIRA_ALLOWED_HOSTS,
    headers: authHeaders(ctx),
  })
  const byId = new Map((embedded.comments ?? []).map((comment) => [comment.id, comment]))
  for (const comment of newest.comments ?? []) byId.set(comment.id, comment)
  return {
    ...issue,
    fields: { ...issue.fields, comment: { ...embedded, comments: [...byId.values()] } },
  }
}

export const createJiraComment = async (
  http: JiraTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  item: { externalId: string; externalKey: string },
  body: string,
): Promise<NormalisedComment> => {
  const { cloudId, siteUrl } = containerOf(container)
  const echo = await http.json<JiraComment>({
    url: `${apiBase(cloudId)}/issue/${encodeURIComponent(item.externalKey)}/comment`,
    method: 'POST',
    allowedHosts: JIRA_ALLOWED_HOSTS,
    headers: authHeaders(ctx),
    body: JSON.stringify({ body: markdownToAdf(body) }),
  })
  return normaliseJiraComment(echo, { id: item.externalId, key: item.externalKey }, siteUrl)
}

/**
 * Jira addresses a comment under its issue, and the write-back knows only the
 * comment's id. `comment/list` answers with each comment's `self` link, which
 * names the issue — one read rather than a second id stored on every row.
 */
const issueIdOfComment = async (
  http: JiraTransport,
  ctx: ConnectionContext,
  cloudId: string,
  commentId: string,
): Promise<string> => {
  const found = await http.json<{ values?: JiraComment[] }>({
    url: `${apiBase(cloudId)}/comment/list`,
    method: 'POST',
    allowedHosts: JIRA_ALLOWED_HOSTS,
    headers: authHeaders(ctx),
    body: JSON.stringify({ ids: [Number(commentId)] }),
  })
  const issueId = issueIdFromCommentSelf(found.values?.[0]?.self)
  if (!issueId) {
    throw new SourceRejectedError('JIRA_COMMENT_GONE', 'That comment no longer exists in Jira.')
  }
  return issueId
}

export const updateJiraComment = async (
  http: JiraTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  comment: { externalId: string },
  body: string,
): Promise<NormalisedComment> => {
  const { cloudId, siteUrl } = containerOf(container)
  const issueId = await issueIdOfComment(http, ctx, cloudId, comment.externalId)
  const echo = await http.json<JiraComment>({
    url: `${apiBase(cloudId)}/issue/${issueId}/comment/${encodeURIComponent(comment.externalId)}`,
    method: 'PUT',
    allowedHosts: JIRA_ALLOWED_HOSTS,
    headers: authHeaders(ctx),
    body: JSON.stringify({ body: markdownToAdf(body) }),
  })
  return normaliseJiraComment(echo, { id: issueId }, siteUrl)
}

export const deleteJiraComment = async (
  http: JiraTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  comment: { externalId: string },
): Promise<void> => {
  const { cloudId } = containerOf(container)
  const issueId = await issueIdOfComment(http, ctx, cloudId, comment.externalId)
  await http.json({
    url: `${apiBase(cloudId)}/issue/${issueId}/comment/${encodeURIComponent(comment.externalId)}`,
    method: 'DELETE',
    allowedHosts: JIRA_ALLOWED_HOSTS,
    headers: authHeaders(ctx),
  })
}

/**
 * One Jira file, through the API gateway with the source's token.
 * `redirect=false` asks Jira to stream the bytes itself rather than answer with
 * a 303 to its media host — a redirect the envelope would (rightly) not follow
 * with a credential attached.
 */
export const fetchJiraAsset = async (
  http: JiraTransport,
  ctx: ConnectionContext,
  asset: { url: string },
): Promise<AssetStream | null> => {
  const url = new URL(asset.url)
  if (
    !(JIRA_ASSET_HOSTS as readonly string[]).includes(url.hostname) ||
    !/\/rest\/api\/3\/attachment\/content\/[^/]+$/.test(url.pathname)
  ) {
    return null
  }
  url.searchParams.set('redirect', 'false')
  try {
    const response = await http.stream({
      url: url.toString(),
      allowedHosts: JIRA_ASSET_HOSTS,
      headers: { authorization: `Bearer ${ctx.credential.accessToken}` },
    })
    if (response.status >= 300) {
      response.stream.destroy()
      throw new SourceHttpError(response.status, 'Jira answered the file with a redirect')
    }
    return { stream: response.stream, contentType: response.contentType, sizeBytes: response.sizeBytes }
  } catch (cause) {
    if (cause instanceof SourceHttpError && cause.status === 404) return null
    throw cause
  }
}
