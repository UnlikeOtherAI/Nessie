import type { NormalisedItem } from '@nessie/board-sources'

export type GitHubIssue = {
  id: number
  node_id: string
  number: number
  html_url: string
  title: string
  body: string | null
  state: 'open' | 'closed'
  state_reason: 'completed' | 'not_planned' | 'reopened' | null
  assignee: { id: number; login: string; email?: string | null } | null
  labels: ({ id: number; name: string } | string)[]
  created_at: string
  updated_at: string
  /** Present on rows that are actually pull requests, which are dropped. */
  pull_request?: unknown
}

/**
 * GitHub's state vocabulary is `open` / `closed`, with a reason. There is no
 * in-progress and no review — those only exist on a Projects v2 board or as a
 * label somebody binds, which is why an Issues container maps to two states and
 * not four.
 */
export const githubIssueState = (issue: GitHubIssue): {
  id: string
  name: string
  category: 'todo' | 'done' | 'archived'
} => {
  if (issue.state === 'open') return { id: 'open', name: 'Open', category: 'todo' }
  if (issue.state_reason === 'not_planned') {
    return { id: 'closed:not_planned', name: 'Closed as not planned', category: 'archived' }
  }
  return { id: 'closed:completed', name: 'Closed', category: 'done' }
}

export const GITHUB_ISSUE_STATES = [
  { id: 'open', name: 'Open', suggestedCategory: 'todo' as const },
  { id: 'closed:completed', name: 'Closed', suggestedCategory: 'done' as const },
  {
    id: 'closed:not_planned',
    name: 'Closed as not planned',
    suggestedCategory: 'archived' as const,
  },
]

export const normaliseGitHubIssue = (issue: GitHubIssue): NormalisedItem => {
  const state = githubIssueState(issue)
  const labels = issue.labels.map((label) =>
    typeof label === 'string'
      ? { id: label, label }
      : { id: String(label.id), label: label.name },
  )
  return {
    externalId: issue.node_id,
    externalKey: `#${issue.number}`,
    url: issue.html_url,
    title: issue.title,
    description: issue.body,
    stateId: state.id,
    stateName: state.name,
    assignee: issue.assignee
      ? {
          externalUserId: String(issue.assignee.id),
          displayName: issue.assignee.login,
          // Public only, and usually absent — GitHub hides it by default.
          ...(issue.assignee.email ? { email: issue.assignee.email } : {}),
        }
      : null,
    // GitHub issues carry no priority of their own; a label mapped to the
    // priority field is how a repository expresses one.
    priority: null,
    dueDate: null,
    labels,
    fields: { labels: labels.map((label) => label.id) },
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    archived: state.category === 'archived',
  }
}

export type ProjectV2Item = {
  id: string
  updatedAt: string
  isArchived: boolean
  content: {
    __typename?: string
    id?: string
    number?: number
    title?: string
    body?: string | null
    url?: string
    createdAt?: string
    updatedAt?: string
    assignees?: { nodes: { id: string; login: string }[] }
  } | null
  fieldValues: {
    nodes: {
      __typename?: string
      name?: string
      optionId?: string
      text?: string
      number?: number
      date?: string
      field?: { name?: string }
    }[]
  }
}

/**
 * A Projects v2 item's state is its `Status` single-select value. Anything else
 * on the board is a custom field, and lands in one.
 */
export const normaliseProjectItem = (item: ProjectV2Item): NormalisedItem | null => {
  const content = item.content
  if (!content?.id || !content.url) return null

  const values = item.fieldValues.nodes ?? []
  const status = values.find((value) => value.field?.name === 'Status')
  const fields: Record<string, unknown> = {}
  for (const value of values) {
    const name = value.field?.name
    if (!name || name === 'Status') continue
    fields[name] = value.name ?? value.text ?? value.number ?? value.date ?? null
  }

  return {
    externalId: item.id,
    externalKey: content.number ? `#${content.number}` : item.id.slice(0, 8),
    url: content.url,
    title: content.title ?? 'Untitled',
    description: content.body ?? null,
    stateId: status?.optionId ?? 'no-status',
    stateName: status?.name ?? 'No status',
    assignee: content.assignees?.nodes[0]
      ? {
          externalUserId: content.assignees.nodes[0].id,
          displayName: content.assignees.nodes[0].login,
        }
      : null,
    priority: null,
    dueDate: null,
    labels: [],
    fields,
    createdAt: content.createdAt ?? item.updatedAt,
    updatedAt: item.updatedAt,
    archived: item.isArchived,
  }
}
