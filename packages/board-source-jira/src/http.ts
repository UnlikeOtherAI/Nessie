import {
  type ConnectionContext,
  type SourceFetchInput,
  type SourceFetchStreamInput,
  type SourceStreamResponse,
  sourceFetchJson,
  sourceFetchStream,
} from '@nessie/board-sources'

export const JIRA_API_HOST = 'api.atlassian.com'
export const JIRA_AUTH_HOST = 'auth.atlassian.com'
export const JIRA_ALLOWED_HOSTS = [JIRA_API_HOST, JIRA_AUTH_HOST] as const

/**
 * The calls this adapter makes, through the shared envelope. Replaceable so
 * the comment write-backs and the file fetch can be tested against recorded
 * answers; production never sets it.
 */
export type JiraTransport = {
  json: <T>(input: SourceFetchInput) => Promise<T>
  stream: (input: SourceFetchStreamInput) => Promise<SourceStreamResponse>
}

export const defaultJiraTransport: JiraTransport = {
  json: sourceFetchJson,
  stream: sourceFetchStream,
}

export const apiBase = (cloudId: string): string =>
  `https://${JIRA_API_HOST}/ex/jira/${cloudId}/rest/api/3`

export const authHeaders = (ctx: ConnectionContext): Record<string, string> => ({
  authorization: `Bearer ${ctx.credential.accessToken}`,
  'content-type': 'application/json',
})

/** What a search or a re-read asks for; `search` is lighter because nothing is applied from it. */
export const ISSUE_FIELDS =
  'summary,description,status,assignee,priority,duedate,labels,created,updated,issuetype'
export const SYNC_FIELDS = `${ISSUE_FIELDS},comment,attachment`

/**
 * Issues per sync page. Lower than the search maximum because each issue now
 * carries its comments as ADF, and the envelope caps a response at 1 MiB — a
 * page that could exceed it would stall the sync on the same page forever.
 */
export const JIRA_SYNC_PAGE_SIZE = 50
