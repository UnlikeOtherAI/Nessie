import {
  type ConnectionContext,
  SourceContainerGoneError,
  type SourceFetchInput,
  type SourceFetchStreamInput,
  SourceRejectedError,
  type SourceResponse,
  type SourceStreamResponse,
  sourceFetch,
  sourceFetchJson,
  sourceFetchStream,
} from '@nessie/board-sources'

export const GITHUB_API_HOST = 'api.github.com'
export const GITHUB_WEB_HOST = 'github.com'
export const GITHUB_ALLOWED_HOSTS = [GITHUB_API_HOST, GITHUB_WEB_HOST] as const

/**
 * The three shapes of call this adapter makes, all through the shared
 * envelope. Replaceable so the lanes and the write-backs can be tested against
 * recorded answers; production never sets it.
 */
export type GitHubTransport = {
  json: <T>(input: SourceFetchInput) => Promise<T>
  raw: (input: SourceFetchInput) => Promise<SourceResponse>
  stream: (input: SourceFetchStreamInput) => Promise<SourceStreamResponse>
}

export const defaultGitHubTransport: GitHubTransport = {
  json: sourceFetchJson,
  raw: sourceFetch,
  stream: sourceFetchStream,
}

export const restHeaders = (ctx: ConnectionContext): Record<string, string> => ({
  authorization: `Bearer ${ctx.credential.accessToken}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'nessie-board-source',
})

export const repoOf = (container: Record<string, unknown>): { owner: string; repo: string } => ({
  owner: String(container.owner ?? ''),
  repo: String(container.repo ?? ''),
})

export const repoApi = (container: Record<string, unknown>): string => {
  const { owner, repo } = repoOf(container)
  return `https://${GITHUB_API_HOST}/repos/${owner}/${repo}`
}

export const isRepository = (container: Record<string, unknown>): boolean =>
  container.kind === 'repository'

export type GitHubGraphQlPayload<T> = { data?: T | null; errors?: { message: string }[] }

/** One GraphQL call, errors and all — for the caller that tolerates a partial answer. */
export const graphqlPayload = async <T>(
  http: GitHubTransport,
  ctx: ConnectionContext,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GitHubGraphQlPayload<T>> =>
  http.json<GitHubGraphQlPayload<T>>({
    url: `https://${GITHUB_API_HOST}/graphql`,
    method: 'POST',
    allowedHosts: GITHUB_ALLOWED_HOSTS,
    headers: { ...restHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })

export const graphql = async <T>(
  http: GitHubTransport,
  ctx: ConnectionContext,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  const payload = await graphqlPayload<T>(http, ctx, query, variables)
  if (payload.errors?.length) {
    throw new SourceRejectedError('GITHUB_GRAPHQL_ERROR', payload.errors[0]?.message ?? 'refused')
  }
  if (!payload.data) throw new SourceContainerGoneError('GitHub answered with no data')
  return payload.data
}
