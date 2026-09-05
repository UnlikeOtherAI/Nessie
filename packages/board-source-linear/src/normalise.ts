import type { NormalisedItem } from '@nessie/board-sources'

/** The shape the issue query asks for. */
export type LinearIssue = {
  id: string
  identifier: string
  url: string
  title: string
  description: string | null
  priority: number | null
  estimate: number | null
  dueDate: string | null
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  state: { id: string; name: string; type: string } | null
  assignee: { id: string; name: string; email: string | null } | null
  labels: { nodes: { id: string; name: string }[] } | null
}

/** Linear's own numeric priority. 0 means "no priority", not "lowest". */
export const LINEAR_PRIORITY_TOKENS: Record<number, string> = {
  0: 'none',
  1: 'urgent',
  2: 'high',
  3: 'medium',
  4: 'low',
}

/**
 * `state.type` is Linear's own classification and the only honest basis for a
 * default category. Nothing maps to `review`: a state's *name* is not evidence
 * of its meaning, so a person promotes one deliberately (design §5.8).
 */
export const linearStateCategory = (
  type: string,
): 'todo' | 'in_progress' | 'done' | 'archived' | null => {
  switch (type) {
    case 'triage':
    case 'backlog':
    case 'unstarted':
      return 'todo'
    case 'started':
      return 'in_progress'
    case 'completed':
      return 'done'
    case 'canceled':
      return 'archived'
    default:
      return null
  }
}

export const normaliseLinearIssue = (issue: LinearIssue): NormalisedItem => ({
  externalId: issue.id,
  externalKey: issue.identifier,
  url: issue.url,
  title: issue.title,
  description: issue.description,
  stateId: issue.state?.id ?? '',
  stateName: issue.state?.name ?? '',
  assignee: issue.assignee
    ? {
        externalUserId: issue.assignee.id,
        displayName: issue.assignee.name,
        ...(issue.assignee.email ? { email: issue.assignee.email } : {}),
      }
    : null,
  priority:
    issue.priority === null || issue.priority === undefined
      ? null
      : LINEAR_PRIORITY_TOKENS[issue.priority] ?? null,
  dueDate: issue.dueDate ? issue.dueDate.slice(0, 10) : null,
  labels: (issue.labels?.nodes ?? []).map((label) => ({ id: label.id, label: label.name })),
  fields: {
    estimate: issue.estimate ?? null,
    labels: (issue.labels?.nodes ?? []).map((label) => label.id),
  },
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  archived: Boolean(issue.archivedAt) || issue.state?.type === 'canceled',
})
