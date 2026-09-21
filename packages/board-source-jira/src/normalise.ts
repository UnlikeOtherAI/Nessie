import type {
  NormalisedAttachment,
  NormalisedComment,
  NormalisedItem,
} from '@nessie/board-sources'

import { adfToMarkdown } from './adf.js'

export type JiraUser = {
  accountId: string
  displayName: string
  emailAddress?: string | null
  /** `atlassian` for a person, `app` for an integration, `customer` for JSM. */
  accountType?: string | null
}

export type JiraComment = {
  id: string
  /** `…/rest/api/3/issue/{issueId}/comment/{id}` — how a bare comment id finds its issue. */
  self?: string
  author?: JiraUser | null
  /** ADF in API v3. */
  body?: unknown
  created: string
  updated: string
  /** A role or group restriction: a narrower audience than the issue. */
  visibility?: { type?: string; value?: string } | null
  /** Jira Service Management: `false` is an internal note customers never see. */
  jsdPublic?: boolean
}

export type JiraAttachment = {
  id: string
  filename?: string | null
  mimeType?: string | null
  size?: number | null
  /** The site-host download URL; a 3LO token reaches it through the API gateway instead. */
  content?: string | null
  created: string
}

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
    /** Present when the read asked for `comment`. */
    comment?: { comments?: JiraComment[]; total?: number; maxResults?: number } | null
    /** Present when the read asked for `attachment`. */
    attachment?: JiraAttachment[] | null
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

/** The one host a Jira file is fetched from: the 3LO API gateway. */
export const JIRA_ASSET_HOSTS = ['api.atlassian.com'] as const

/** A file's address through the gateway — the only one a 3LO token opens. */
export const jiraAttachmentUrl = (cloudId: string, attachmentId: string): string =>
  `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/attachment/content/${attachmentId}`

/**
 * A comment whose audience is narrower than its issue's (§4.3): a role or
 * group `visibility`, or a Service Management internal note. It is flagged
 * rather than dropped here — the adapter reports what it read, and the apply
 * step is the one place that decides it is never stored.
 */
export const isRestrictedJiraComment = (comment: JiraComment): boolean =>
  Boolean(comment.visibility) || comment.jsdPublic === false

export const normaliseJiraComment = (
  comment: JiraComment,
  issue: { id: string; key?: string },
  siteUrl: string,
): NormalisedComment => {
  // An integration's comment is shown under its own name rather than offered
  // to the People table as somebody to link.
  const app = comment.author?.accountType === 'app'
  const restricted = isRestrictedJiraComment(comment)
  return {
    externalId: comment.id,
    issueExternalId: issue.id,
    // A restricted comment's text is never carried past the adapter.
    body: restricted ? '' : adfToMarkdown(comment.body),
    author:
      comment.author && !app
        ? {
            externalUserId: comment.author.accountId,
            displayName: comment.author.displayName,
            ...(comment.author.emailAddress ? { email: comment.author.emailAddress } : {}),
          }
        : null,
    authorDisplay: comment.author && app ? comment.author.displayName : null,
    createdAt: comment.created,
    updatedAt: comment.updated,
    editedAt: comment.updated !== comment.created ? comment.updated : null,
    url: issue.key
      ? `${siteUrl.replace(/\/$/, '')}/browse/${issue.key}?focusedCommentId=${comment.id}`
      : null,
    parentExternalId: null,
    ...(restricted ? { restricted: true } : {}),
  }
}

/** The issue id a comment's `self` link names, or null. */
export const issueIdFromCommentSelf = (self: string | undefined): string | null => {
  const match = /\/issue\/(\d+)\/comment\//.exec(self ?? '')
  return match ? (match[1] as string) : null
}

const jiraAttachments = (issue: JiraIssue, cloudId: string): NormalisedAttachment[] =>
  (issue.fields.attachment ?? []).flatMap((attachment) => {
    const url = cloudId ? jiraAttachmentUrl(cloudId, attachment.id) : attachment.content
    if (!url) return []
    return [
      {
        externalId: attachment.id,
        issueExternalId: issue.id,
        url,
        title: attachment.filename ?? null,
        contentType: attachment.mimeType ?? null,
        sizeBytes: attachment.size ?? null,
        kind: 'file' as const,
        createdAt: attachment.created,
      },
    ]
  })

/**
 * An issue, with its comments and files when the read asked for them —
 * `undefined` for either means "not read on this call", never "none". Inline
 * ADF `media` nodes are not resolved in v1 (their ids are not URLs); the
 * attachment list carries the file instead.
 */
export const normaliseJiraIssue = (
  issue: JiraIssue,
  siteUrl: string,
  cloudId = '',
): NormalisedItem => {
  const comments = issue.fields.comment
    ? (issue.fields.comment.comments ?? []).map((comment) =>
        normaliseJiraComment(comment, issue, siteUrl),
      )
    : undefined
  return {
    ...normaliseJiraIssueFields(issue, siteUrl),
    ...(comments ? { comments } : {}),
    ...(issue.fields.attachment ? { attachments: jiraAttachments(issue, cloudId) } : {}),
  }
}

const normaliseJiraIssueFields = (issue: JiraIssue, siteUrl: string): NormalisedItem => {
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
    // Jira labels are bare strings with no colour: the name is the id, and the
    // project label takes the default colour until a person recolours it.
    labels: (issue.fields.labels ?? []).map((label) => ({ id: label, label })),
    fields: {
      // Kept beside the first-class `labels` so a source whose mapping still
      // names the `labels` key fingerprints exactly as before: no mass re-apply.
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
