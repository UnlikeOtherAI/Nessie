import {
  type NormalisedAttachment,
  type NormalisedComment,
  type NormalisedItem,
  type NormalisedItemLabel,
  inlineAssetsIn,
} from '@nessie/board-sources'

/**
 * The one host Linear serves uploaded files from. A URL here is bytes the
 * source's own credential can read; anything else a Linear attachment points
 * at (a GitHub PR, a Figma frame) is a link, and stays one.
 */
export const LINEAR_ASSET_HOSTS = ['uploads.linear.app'] as const

export type LinearLabel = {
  id: string
  name: string
  color?: string | null
  parent?: { id: string; name: string } | null
}

export type LinearAttachment = {
  id: string
  title: string | null
  subtitle?: string | null
  url: string
  sourceType?: string | null
  createdAt: string
  updatedAt?: string
}

export type LinearComment = {
  id: string
  body: string
  createdAt: string
  updatedAt: string
  editedAt?: string | null
  url?: string | null
  user?: { id: string; name: string; email?: string | null } | null
  botActor?: { id: string | null; name: string | null } | null
  issue?: { id: string } | null
  parent?: { id: string } | null
}

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
  labels: { nodes: LinearLabel[] } | null
  attachments?: { nodes: LinearAttachment[] } | null
  /** Selected only by the by-id re-read; absent means "not read on this call". */
  comments?: { nodes: LinearComment[] } | null
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
    // Linear creates a `duplicate` state in every team it makes, so this is not
    // an exotic case: without it every real workspace connects with an unmapped
    // state and the source turns `misconfigured` on its first sync. A duplicate
    // leaves the board for the same reason a cancellation does — the work is
    // not done, it is not happening here — so it lands where cancellations do.
    case 'duplicate':
      return 'archived'
    default:
      return null
  }
}

const HEX_COLOUR = /^#[0-9a-f]{6}$/

/**
 * A Linear label as the mirror names it. A label inside a group is shown in
 * Linear as `Group / Name`, and two groups may each hold a `Bug`, so the group
 * is part of the name — otherwise they would collide into one project label.
 */
export const normaliseLinearLabel = (label: LinearLabel): NormalisedItemLabel => {
  const colour = label.color?.trim().toLowerCase() ?? ''
  return {
    id: label.id,
    label: label.parent?.name ? `${label.parent.name} / ${label.name}` : label.name,
    ...(HEX_COLOUR.test(colour) ? { color: colour } : {}),
  }
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

export const normaliseLinearComment = (
  comment: LinearComment,
  issueExternalId?: string,
): NormalisedComment => ({
  externalId: comment.id,
  issueExternalId: comment.issue?.id ?? issueExternalId ?? '',
  body: comment.body ?? '',
  author: comment.user
    ? {
        externalUserId: comment.user.id,
        displayName: comment.user.name,
        ...(comment.user.email ? { email: comment.user.email } : {}),
      }
    : null,
  // An integration's comment (a GitHub sync, a Slack thread) has no user. It
  // is shown under the integration's own name rather than as nobody.
  authorDisplay: comment.user ? null : comment.botActor?.name ?? null,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  editedAt: comment.editedAt ?? null,
  url: comment.url ?? null,
  parentExternalId: comment.parent?.id ?? null,
})

/**
 * Everything file-shaped an issue carries: its attachment list — `file` when
 * the URL is Linear's own upload host, `link` otherwise — plus the uploads
 * referenced inside its description and, when read, its comments' bodies.
 */
export const linearAttachments = (
  issue: LinearIssue,
  comments: NormalisedComment[] | undefined,
): NormalisedAttachment[] => {
  const listed: NormalisedAttachment[] = (issue.attachments?.nodes ?? []).map((attachment) => ({
    externalId: attachment.id,
    issueExternalId: issue.id,
    url: attachment.url,
    title: attachment.title ?? attachment.subtitle ?? null,
    kind: (LINEAR_ASSET_HOSTS as readonly string[]).includes(hostOf(attachment.url) ?? '')
      ? ('file' as const)
      : ('link' as const),
    createdAt: attachment.createdAt,
  }))
  const inline = [
    ...inlineAssetsIn(issue.description, LINEAR_ASSET_HOSTS, {
      issueExternalId: issue.id,
      createdAt: issue.createdAt,
    }),
    ...(comments ?? []).flatMap((comment) =>
      inlineAssetsIn(comment.body, LINEAR_ASSET_HOSTS, {
        issueExternalId: issue.id,
        commentExternalId: comment.externalId,
        createdAt: comment.createdAt,
      }),
    ),
  ]
  // The URL is the idempotency key, so one file both listed and pasted inline
  // is one asset; the listed entry wins because it carries Linear's id.
  const byUrl = new Map<string, NormalisedAttachment>()
  for (const attachment of [...listed, ...inline]) {
    if (!byUrl.has(attachment.url)) byUrl.set(attachment.url, attachment)
  }
  return [...byUrl.values()]
}

export const normaliseLinearIssue = (issue: LinearIssue): NormalisedItem => {
  const comments = issue.comments
    ? issue.comments.nodes.map((comment) => normaliseLinearComment(comment, issue.id))
    : undefined
  return {
    ...normaliseLinearIssueFields(issue),
    ...(comments ? { comments } : {}),
    attachments: linearAttachments(issue, comments),
  }
}

const normaliseLinearIssueFields = (issue: LinearIssue): NormalisedItem => ({
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
  labels: (issue.labels?.nodes ?? []).map(normaliseLinearLabel),
  fields: {
    estimate: issue.estimate ?? null,
    // Kept beside the first-class `labels` so a source whose mapping still
    // names the `labels` key fingerprints exactly as it did before labels
    // became native: no mass re-apply on upgrade.
    labels: (issue.labels?.nodes ?? []).map((label) => label.id),
  },
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
  archived: Boolean(issue.archivedAt) || issue.state?.type === 'canceled',
})
