/** The GraphQL documents the adapter sends, kept out of the logic files. */

export const ISSUE_FIELDS = `
  id
  identifier
  url
  title
  description
  priority
  estimate
  dueDate
  createdAt
  updatedAt
  archivedAt
  state { id name type }
  assignee { id name email }
  labels { nodes { id name } }
`

export const VIEWER_QUERY = `
  query Viewer {
    viewer { id name email }
    organization { id name urlKey }
  }
`

export const TEAMS_QUERY = `
  query Teams($after: String) {
    teams(first: 50, after: $after) {
      nodes { id key name }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const TEAM_DESCRIPTION_QUERY = `
  query TeamDescription($teamId: String!) {
    team(id: $teamId) {
      id
      name
      states(first: 100) { nodes { id name type position } }
      members(first: 100) { nodes { id name email active } }
      labels(first: 100) { nodes { id name } }
    }
  }
`

export const ISSUES_PAGE_QUERY = `
  query IssuesPage($teamId: ID!, $after: String, $updatedAfter: DateTimeOrDuration) {
    issues(
      first: 100
      after: $after
      filter: { team: { id: { eq: $teamId } }, updatedAt: { gt: $updatedAfter } }
      orderBy: updatedAt
      includeArchived: true
    ) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const ISSUES_BY_ID_QUERY = `
  query IssuesById($ids: [ID!]!) {
    issues(first: 100, filter: { id: { in: $ids } }, includeArchived: true) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`

export const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue { ${ISSUE_FIELDS} }
    }
  }
`

/**
 * Registering this deployment's own callback, rather than depending on a
 * webhook configured once on an OAuth app. `secret` is Linear's to mint and is
 * returned exactly once, here — there is no query that reads it back later.
 */
export const WEBHOOK_CREATE_MUTATION = `
  mutation WebhookCreate($input: WebhookCreateInput!) {
    webhookCreate(input: $input) {
      success
      webhook { id enabled secret }
    }
  }
`

export const WEBHOOK_DELETE_MUTATION = `
  mutation WebhookDelete($id: String!) {
    webhookDelete(id: $id) { success }
  }
`

/**
 * Linear's own relevance, narrowed to the team the source attached.
 *
 * `searchIssues` is the API behind Linear's search box, so a person's words
 * find what they would find in Linear itself. Archived issues stay out: an
 * item search is for work somebody can still act on.
 */
export const ISSUE_SEARCH_QUERY = `
  query IssueSearch($term: String!, $teamId: ID!, $first: Int!) {
    searchIssues(
      term: $term
      first: $first
      filter: { team: { id: { eq: $teamId } } }
    ) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`
