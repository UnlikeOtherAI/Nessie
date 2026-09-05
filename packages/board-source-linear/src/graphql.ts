import { sourceFetchJson, SourceHttpError } from '@nessie/board-sources'

export const LINEAR_API_HOST = 'api.linear.app'
export const LINEAR_AUTH_HOST = 'linear.app'
export const LINEAR_ALLOWED_HOSTS = [LINEAR_API_HOST, LINEAR_AUTH_HOST] as const

const GRAPHQL_URL = `https://${LINEAR_API_HOST}/graphql`

type GraphQlResponse<T> = {
  data?: T
  errors?: { message: string; extensions?: { code?: string } }[]
}

/**
 * One GraphQL call. Linear reports application errors inside a 200, so the
 * `errors` array is checked here rather than at every call site — otherwise a
 * refusal would look like an empty page and quietly truncate a sync.
 */
export const linearGraphQl = async <T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  const payload = await sourceFetchJson<GraphQlResponse<T>>({
    url: GRAPHQL_URL,
    method: 'POST',
    allowedHosts: LINEAR_ALLOWED_HOSTS,
    headers: {
      authorization: accessToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })
  if (payload.errors && payload.errors.length > 0) {
    const first = payload.errors[0]
    throw new SourceHttpError(200, first?.message ?? 'Linear refused the query')
  }
  if (!payload.data) {
    throw new SourceHttpError(200, 'Linear answered with no data')
  }
  return payload.data
}
