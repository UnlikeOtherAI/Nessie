import {
  type AssetStream,
  type ConnectionContext,
  type NormalisedComment,
  type NormalisedItemLabel,
  SourceHttpError,
  SourceRejectedError,
} from '@nessie/board-sources'

import {
  GITHUB_ALLOWED_HOSTS,
  type GitHubTransport,
  isRepository,
  repoApi,
  restHeaders,
} from './http.js'
import {
  type GitHubComment,
  type GitHubLabel,
  isGitHubAssetUrl,
  normaliseGitHubComment,
  normaliseGitHubLabel,
} from './normalise.js'

/**
 * Everything a repository source does beyond its issues: its label list, the
 * comment write-backs and the pasted files. Split from the adapter so each
 * half stays readable on its own.
 */

/** A repository with more labels than this is not a board a person curates. */
const LABEL_PAGES = 10

export const listRepositoryLabels = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
): Promise<GitHubLabel[]> => {
  const all: GitHubLabel[] = []
  for (let page = 1; page <= LABEL_PAGES; page += 1) {
    const rows = await http.json<GitHubLabel[]>({
      url: `${repoApi(container)}/labels?per_page=100&page=${page}`,
      allowedHosts: GITHUB_ALLOWED_HOSTS,
      headers: restHeaders(ctx),
    })
    all.push(...rows)
    if (rows.length < 100) break
  }
  return all
}

export const describeRepositoryLabels = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
): Promise<NormalisedItemLabel[]> =>
  (await listRepositoryLabels(http, ctx, container)).map(normaliseGitHubLabel)

/**
 * GitHub sets an issue's labels by name; the mirror knows them by id. The
 * names are read fresh rather than trusted from the mirror, so a rename
 * upstream since the last describe cannot set the wrong label.
 */
export const labelNamesFor = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  labelIds: readonly string[],
): Promise<string[]> => {
  if (labelIds.length === 0) return []
  const byId = new Map(
    (await listRepositoryLabels(http, ctx, container)).map((label) => [String(label.id), label.name]),
  )
  return labelIds.map((id) => {
    const name = byId.get(id)
    if (!name) {
      throw new SourceRejectedError(
        'GITHUB_LABEL_GONE',
        'One of those labels no longer exists in the GitHub repository.',
      )
    }
    return name
  })
}

const assertRepository = (container: Record<string, unknown>): void => {
  if (!isRepository(container)) {
    throw new SourceRejectedError(
      'GITHUB_PROJECT_READ_ONLY',
      'Commenting on a GitHub Projects board item from Nessie is not supported — comment on its issue in GitHub.',
    )
  }
}

export const createGitHubComment = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  item: { externalId: string; externalKey: string },
  body: string,
): Promise<NormalisedComment> => {
  assertRepository(container)
  const number = item.externalKey.replace('#', '')
  const echo = await http.json<GitHubComment>({
    url: `${repoApi(container)}/issues/${number}/comments`,
    method: 'POST',
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: { ...restHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  return normaliseGitHubComment(echo, item.externalId)
}

export const updateGitHubComment = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  comment: { externalId: string },
  body: string,
): Promise<NormalisedComment> => {
  assertRepository(container)
  const echo = await http.json<GitHubComment>({
    url: `${repoApi(container)}/issues/comments/${encodeURIComponent(comment.externalId)}`,
    method: 'PATCH',
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: { ...restHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  // The echo names its issue only by URL; the write-back keeps the row's own
  // task, so the node id is not needed here.
  return normaliseGitHubComment(echo, '')
}

export const deleteGitHubComment = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  container: Record<string, unknown>,
  comment: { externalId: string },
): Promise<void> => {
  assertRepository(container)
  await http.json({
    url: `${repoApi(container)}/issues/comments/${encodeURIComponent(comment.externalId)}`,
    method: 'DELETE',
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: restHeaders(ctx),
  })
}

/** Where `fetchAsset` may be sent: GitHub's upload URLs and where they redirect. */
export const GITHUB_ASSET_FETCH_HOSTS = [
  'github.com',
  'user-images.githubusercontent.com',
] as const

/**
 * Where an upload URL redirects to: a short-lived signed URL whose query is
 * the authority, so it is fetched with no credential attached at all.
 */
export const GITHUB_ASSET_REDIRECT_HOSTS = [
  'private-user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-production-user-asset-6210df.s3.amazonaws.com',
] as const

/**
 * One pasted file. `github.com/user-attachments/…` answers the token with a
 * redirect to a signed URL; the envelope never follows a redirect while a
 * credential rides on the request, so the hop is taken here by hand — a HEAD
 * with the token, then the signed URL with nothing, and only onto a host this
 * adapter names. Anything that is not an upload URL is refused before a call.
 */
export const fetchGitHubAsset = async (
  http: GitHubTransport,
  ctx: ConnectionContext,
  asset: { url: string },
): Promise<AssetStream | null> => {
  if (!isGitHubAssetUrl(asset.url)) return null
  const auth = { authorization: `Bearer ${ctx.credential.accessToken}`, 'user-agent': 'nessie-board-source' }
  try {
    const probe = await http.raw({
      url: asset.url,
      method: 'HEAD',
      allowedHosts: GITHUB_ASSET_FETCH_HOSTS,
      headers: { ...auth, accept: '*/*' },
    })
    let target: { url: string; headers: Record<string, string>; hosts: readonly string[] } = {
      url: asset.url,
      headers: auth,
      hosts: GITHUB_ASSET_FETCH_HOSTS,
    }
    if (probe.status >= 300 && probe.status < 400) {
      const location = probe.headers.get('location')
      const next = location ? new URL(location, asset.url) : null
      if (!next || !(GITHUB_ASSET_REDIRECT_HOSTS as readonly string[]).includes(next.hostname)) {
        throw new SourceHttpError(probe.status, 'GitHub redirected the file somewhere unexpected')
      }
      target = { url: next.toString(), headers: {}, hosts: GITHUB_ASSET_REDIRECT_HOSTS }
    }
    const response = await http.stream({
      url: target.url,
      allowedHosts: target.hosts,
      headers: target.headers,
    })
    if (response.status >= 300) {
      response.stream.destroy()
      throw new SourceHttpError(response.status, 'GitHub answered the file with another redirect')
    }
    return { stream: response.stream, contentType: response.contentType, sizeBytes: response.sizeBytes }
  } catch (cause) {
    if (cause instanceof SourceHttpError && cause.status === 404) return null
    throw cause
  }
}
