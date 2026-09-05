import type { NormalisedItem } from '@nessie/board-sources'

/** The fields the JQL search asks Jira for. */
export type JiraIssue = {
  id: string
  key: string
  fields: {
    summary?: string | null
    description?: unknown
    status?: { id: string; name: string; statusCategory?: { key?: string } } | null
    assignee?: { accountId: string; displayName: string; emailAddress?: string | null } | null
    priority?: { id: string; name: string } | null
    duedate?: string | null
    labels?: string[] | null
    created?: string
    updated?: string
    [key: string]: unknown
  }
}

/**
 * Jira's own `statusCategory` is the only honest basis for a default: it is
 * Jira's classification of its own workflow, not a guess from a status name.
 * Nothing maps to `review` — a person promotes a status deliberately.
 */
export const jiraStatusCategory = (
  key: string | undefined,
): 'todo' | 'in_progress' | 'done' | null => {
  switch (key) {
    case 'new':
      return 'todo'
    case 'indeterminate':
      return 'in_progress'
    case 'done':
      return 'done'
    default:
      return null
  }
}

/** Jira's five named priorities, onto the four Nessie has. */
export const JIRA_PRIORITY_TOKENS: Record<string, string> = {
  Highest: 'urgent',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Lowest: 'low',
}

/**
 * Jira 3 returns descriptions as Atlassian Document Format. Only the text is
 * wanted, and only the text is taken — rendering ADF is a different feature and
 * a much larger one.
 */
export const adfToText = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return null
  const node = value as { text?: string; content?: unknown[] }
  if (typeof node.text === 'string') return node.text
  if (!Array.isArray(node.content)) return null
  const parts = node.content
    .map((child) => adfToText(child))
    .filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join('\n') : null
}

export const normaliseJiraIssue = (issue: JiraIssue, siteUrl: string): NormalisedItem => {
  const status = issue.fields.status
  return {
    externalId: issue.id,
    externalKey: issue.key,
    url: `${siteUrl.replace(/\/$/, '')}/browse/${issue.key}`,
    title: issue.fields.summary ?? issue.key,
    description: adfToText(issue.fields.description),
    stateId: status?.id ?? '',
    stateName: status?.name ?? '',
    assignee: issue.fields.assignee
      ? {
          externalUserId: issue.fields.assignee.accountId,
          displayName: issue.fields.assignee.displayName,
          // Only present when the account's privacy settings expose it and the
          // token carries `read:jira-user`; absent is normal, not an error.
          ...(issue.fields.assignee.emailAddress
            ? { email: issue.fields.assignee.emailAddress }
            : {}),
        }
      : null,
    priority: issue.fields.priority
      ? JIRA_PRIORITY_TOKENS[issue.fields.priority.name] ?? null
      : null,
    dueDate: issue.fields.duedate ? issue.fields.duedate.slice(0, 10) : null,
    labels: (issue.fields.labels ?? []).map((label) => ({ id: label, label })),
    fields: {
      labels: issue.fields.labels ?? [],
      issuetype:
        (issue.fields.issuetype as { name?: string } | undefined)?.name ?? null,
    },
    createdAt: issue.fields.created ?? new Date(0).toISOString(),
    updatedAt: issue.fields.updated ?? new Date(0).toISOString(),
    // Jira has no "cancelled": an issue leaves the board by being deleted,
    // which arrives as a webhook rather than in a search result.
    archived: false,
  }
}
