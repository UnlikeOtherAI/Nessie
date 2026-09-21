import {
  type NormalisedAttachment,
  type NormalisedComment,
  type NormalisedItem,
  type NormalisedItemLabel,
  inlineAssetsIn,
} from '@nessie/board-sources'

/** A repository label as the REST API returns it: `color` is hex without the `#`. */
export type GitHubLabel = { id: number; name: string; color?: string | null }

/** One issue comment, from the flat lane or an issue's own comment list. */
export type GitHubComment = {
  id: number
  html_url?: string | null
  /** `https://api.github.com/repos/{o}/{r}/issues/{number}` — the only link to the issue. */
  issue_url?: string | null
  body: string | null
  user: { id: number; login: string; type?: string | null } | null
  created_at: string
  updated_at: string
}

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
  labels: (GitHubLabel | string)[]
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

const HEX_COLOUR = /^[0-9a-f]{6}$/

/** A GitHub label, with its colour prefixed into the `#rrggbb` form labels store. */
export const normaliseGitHubLabel = (label: GitHubLabel | string): NormalisedItemLabel => {
  if (typeof label === 'string') return { id: label, label }
  const colour = label.color?.trim().toLowerCase() ?? ''
  return {
    id: String(label.id),
    label: label.name,
    ...(HEX_COLOUR.test(colour) ? { color: `#${colour}` } : {}),
  }
}

/**
 * Hosts GitHub serves pasted uploads from. `github.com` is here only for its
 * `/user-attachments/` paths — everything else on it is a page, not a file —
 * which is why `isGitHubAssetUrl` checks the path and the host list alone is
 * never the test.
 */
export const GITHUB_UPLOAD_HOSTS = ['github.com', 'user-images.githubusercontent.com'] as const

/**
 * What the shared, host-only inline scanner may be given. `github.com` is left
 * out deliberately: that scanner cannot see paths, and with it every link to a
 * pull request or a commit in a comment would become a "file" to download.
 */
export const GITHUB_ASSET_HOSTS = ['user-images.githubusercontent.com'] as const

/** Whether a URL is a file somebody pasted into an issue or a comment. */
export const isGitHubAssetUrl = (raw: string): boolean => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'user-images.githubusercontent.com') return true
  return (
    url.hostname === 'github.com' &&
    (url.pathname.startsWith('/user-attachments/assets/') ||
      url.pathname.startsWith('/user-attachments/files/'))
  )
}

// GitHub's editor pastes an image as an HTML `<img … src="…">` as often as
// Markdown, so both are read; the Markdown half is the shared scanner.
const HTML_IMG_SRC = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi

/** Uploads referenced inside one GitHub body, Markdown or HTML. */
export const gitHubInlineAssets = (
  body: string | null | undefined,
  at: { issueExternalId: string; commentExternalId?: string; createdAt: string },
): NormalisedAttachment[] => {
  if (!body) return []
  const markdown = inlineAssetsIn(body, GITHUB_UPLOAD_HOSTS, at).filter((asset) =>
    isGitHubAssetUrl(asset.url),
  )
  const seen = new Set(markdown.map((asset) => asset.url))
  const html: NormalisedAttachment[] = []
  for (const match of body.matchAll(HTML_IMG_SRC)) {
    const url = match[1]
    if (!url || seen.has(url) || !isGitHubAssetUrl(url)) continue
    seen.add(url)
    html.push({
      issueExternalId: at.issueExternalId,
      ...(at.commentExternalId ? { commentExternalId: at.commentExternalId } : {}),
      url,
      title: new URL(url).pathname.split('/').filter(Boolean).pop() ?? null,
      kind: 'file',
      inline: true,
      createdAt: at.createdAt,
    })
  }
  return [...markdown, ...html]
}

/**
 * One comment. `issueExternalId` is passed in because a GitHub comment names
 * its issue only by URL, and the mirror keys issues by `node_id`.
 */
export const normaliseGitHubComment = (
  comment: GitHubComment,
  issueExternalId: string,
): NormalisedComment => {
  // A bot (Dependabot, an Actions workflow) is shown under its own login
  // rather than offered to the People table as somebody to link.
  const bot = comment.user?.type === 'Bot'
  return {
    externalId: String(comment.id),
    issueExternalId,
    body: comment.body ?? '',
    author:
      comment.user && !bot
        ? { externalUserId: String(comment.user.id), displayName: comment.user.login }
        : null,
    authorDisplay: comment.user && bot ? comment.user.login : null,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    // GitHub keeps no edit flag on the REST shape; a later `updated_at` is one.
    editedAt: comment.updated_at !== comment.created_at ? comment.updated_at : null,
    url: comment.html_url ?? null,
    parentExternalId: null,
  }
}

/** The issue number a comment's `issue_url` names, or null. */
export const issueNumberOf = (comment: Pick<GitHubComment, 'issue_url'>): number | null => {
  const match = /\/issues\/(\d+)$/.exec(comment.issue_url ?? '')
  return match ? Number(match[1]) : null
}

/**
 * An issue, with its comments when this call read them. `undefined` comments
 * means "not read", never "none" — the list endpoint carries only a count.
 */
export const normaliseGitHubIssue = (
  issue: GitHubIssue,
  rawComments?: readonly GitHubComment[],
): NormalisedItem => {
  const comments = rawComments?.map((comment) => normaliseGitHubComment(comment, issue.node_id))
  const attachments = dedupeByUrl([
    ...gitHubInlineAssets(issue.body, { issueExternalId: issue.node_id, createdAt: issue.created_at }),
    ...(comments ?? []).flatMap((comment) =>
      gitHubInlineAssets(comment.body, {
        issueExternalId: issue.node_id,
        commentExternalId: comment.externalId,
        createdAt: comment.createdAt,
      }),
    ),
  ])
  return {
    ...normaliseGitHubIssueFields(issue),
    ...(comments ? { comments } : {}),
    attachments,
  }
}

/** The URL is the idempotency key, so one upload pasted twice is one asset. */
const dedupeByUrl = (assets: NormalisedAttachment[]): NormalisedAttachment[] => {
  const byUrl = new Map<string, NormalisedAttachment>()
  for (const asset of assets) if (!byUrl.has(asset.url)) byUrl.set(asset.url, asset)
  return [...byUrl.values()]
}

const normaliseGitHubIssueFields = (issue: GitHubIssue): NormalisedItem => {
  const state = githubIssueState(issue)
  const labels = issue.labels.map(normaliseGitHubLabel)
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
    // Kept beside the first-class `labels` so a source whose mapping still
    // names the `labels` key fingerprints exactly as before labels became
    // native: no mass re-apply on upgrade.
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
