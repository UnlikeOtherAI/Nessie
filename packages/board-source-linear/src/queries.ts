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
  labels { nodes { id name color parent { id name } } }
  attachments(first: 25) { nodes { id title subtitle url sourceType createdAt updatedAt } }
`

/**
 * One comment, as both the per-issue selection and the flat comment lane read
 * it. `botActor` is set instead of `user` when an integration wrote it.
 */
export const COMMENT_FIELDS = `
  id
  body
  createdAt
  updatedAt
  editedAt
  url
  user { id name email }
  botActor { id name }
  issue { id }
  parent { id }
`

/** A label as the team and workspace listings read it; a grouped one names its group. */
export const LABEL_FIELDS = 'id name color parent { id name }'

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
      labels(first: 250) { nodes { ${LABEL_FIELDS} } }
    }
  }
`

/**
 * Workspace-level labels: a team's issues may carry these as well as the
 * team's own, so describing a team lists both.
 */
export const WORKSPACE_LABELS_QUERY = `
  query WorkspaceLabels {
    issueLabels(first: 250, filter: { team: { null: true } }) {
      nodes { ${LABEL_FIELDS} }
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

/**
 * The webhook path's re-read. Unlike the page query it nests the issue's
 * comments: at most 100 issues per call keeps the nested selection inside
 * Linear's complexity budget, where 100 issues × their comments on every sweep
 * page would not — that is what the flat comment lane is for.
 *
 * Narrowed to the source's team as well as the ids: a `Comment` delivery names
 * no team, so a delivery can reach every Linear source in the deployment, and
 * the re-read is what keeps one team's issue off another team's board.
 */
export const ISSUES_BY_ID_QUERY = `
  query IssuesById($ids: [ID!]!, $teamId: ID!) {
    issues(
      first: 100
      filter: { id: { in: $ids }, team: { id: { eq: $teamId } } }
      includeArchived: true
    ) {
      nodes {
        ${ISSUE_FIELDS}
        comments(first: 50) { nodes { ${COMMENT_FIELDS} } }
      }
    }
  }
`

/** Page sizes, kept together so halving them for the complexity budget is one edit. */
export const COMMENTS_PAGE_SIZE = 100

/**
 * The incremental comment lane: every comment on the team's issues that
 * changed since the lane's own clock, flat, oldest first. A comment edit does
 * not bump its issue's `updatedAt`, so the item pages alone would never see it.
 */
export const COMMENTS_PAGE_QUERY = `
  query CommentsPage($teamId: ID!, $after: String, $updatedAfter: DateTimeOrDuration) {
    comments(
      first: ${COMMENTS_PAGE_SIZE}
      after: $after
      filter: { issue: { team: { id: { eq: $teamId } } }, updatedAt: { gt: $updatedAfter } }
      orderBy: updatedAt
      includeArchived: true
    ) {
      nodes { ${COMMENT_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

export const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment { ${COMMENT_FIELDS} }
    }
  }
`

export const COMMENT_UPDATE_MUTATION = `
  mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) {
      success
      comment { ${COMMENT_FIELDS} }
    }
  }
`

export const COMMENT_DELETE_MUTATION = `
  mutation CommentDelete($id: String!) {
    commentDelete(id: $id) { success }
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
