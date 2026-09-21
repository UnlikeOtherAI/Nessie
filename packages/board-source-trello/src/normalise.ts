import {
  type NormalisedAttachment,
  type NormalisedComment,
  type NormalisedItem,
  type NormalisedItemLabel,
  inlineAssetsIn,
} from '@nessie/board-sources'

export type TrelloLabel = { id: string; name: string; color?: string | null }

export type TrelloAttachment = {
  id: string
  name: string | null
  url: string
  bytes?: number | null
  mimeType?: string | null
  /** True for a file uploaded to Trello; false for a link somebody attached. */
  isUpload?: boolean
  date: string
}

/** A `commentCard` action: Trello keeps a comment as an action on its card. */
export type TrelloCommentAction = {
  id: string
  type?: string
  date: string
  idMemberCreator?: string | null
  memberCreator?: { id: string; fullName?: string | null; username?: string | null } | null
  data: {
    text?: string | null
    dateLastEdited?: string | null
    card?: { id: string; shortLink?: string | null } | null
  }
}

export type TrelloCard = {
  id: string
  idShort?: number
  name: string
  desc: string | null
  url: string
  closed: boolean
  idList: string
  idMembers?: string[]
  labels?: TrelloLabel[]
  due?: string | null
  dateLastActivity?: string
  /** Present when the read asked for them (`attachments=true`). */
  attachments?: TrelloAttachment[]
  /** Present when the read asked for comment actions (`actions=commentCard`). */
  actions?: TrelloCommentAction[]
}

export type TrelloList = { id: string; name: string; pos: number; closed?: boolean }

/**
 * A Trello list *is* the state; there is nothing else. Order is the only signal
 * the board gives about meaning, so the first list is where work starts, the
 * last is where it ends, and everything between is in progress. A person
 * re-maps whatever that gets wrong.
 */
export const trelloListCategory = (
  index: number,
  count: number,
): 'todo' | 'in_progress' | 'done' => {
  if (index === 0) return 'todo'
  if (index === count - 1) return 'done'
  return 'in_progress'
}

/**
 * Trello names its label colours; the mirror stores hex. The values are
 * Trello's own palette (base, `_dark`, `_light`), so a pill here reads as the
 * same colour a person picked there. A label with no colour takes the
 * project's default.
 */
export const TRELLO_LABEL_COLOURS: Readonly<Record<string, string>> = {
  green: '#4bce97', green_dark: '#1f845a', green_light: '#baf3db',
  yellow: '#f5cd47', yellow_dark: '#946f00', yellow_light: '#f8e6a0',
  orange: '#fea362', orange_dark: '#c25100', orange_light: '#fedec8',
  red: '#f87168', red_dark: '#c9372c', red_light: '#ffd5d2',
  purple: '#9f8fef', purple_dark: '#6e5dc6', purple_light: '#dfd8fd',
  blue: '#579dff', blue_dark: '#0c66e4', blue_light: '#cce0ff',
  sky: '#6cc3e0', sky_dark: '#227d9b', sky_light: '#c6edfb',
  lime: '#94c748', lime_dark: '#5b7f24', lime_light: '#d3f1a7',
  pink: '#e774bb', pink_dark: '#ae4787', pink_light: '#fdd0ec',
  black: '#8590a2', black_dark: '#626f86', black_light: '#dcdfe4',
}

/** `green_dark` → `Green dark`: what a colour-only label is called here. */
const colourName = (colour: string): string =>
  colour.charAt(0).toUpperCase() + colour.slice(1).replace(/_/g, ' ')

/**
 * A Trello label. Trello lets a label be a colour with no name — common, and
 * meaningful on the board — so such a label is named after its colour rather
 * than dropped for having no name.
 */
export const normaliseTrelloLabel = (label: TrelloLabel): NormalisedItemLabel => {
  const colour = label.color ? TRELLO_LABEL_COLOURS[label.color] : undefined
  const name = label.name?.trim() || (label.color ? colourName(label.color) : 'Label')
  return { id: label.id, label: name, ...(colour ? { color: colour } : {}) }
}

/** Only this path on Trello's hosts is a file; everything else there is a page. */
export const isTrelloUploadUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw)
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'trello.com' || url.hostname === 'api.trello.com') &&
      /^\/1\/cards\/[^/]+\/attachments\/[^/]+\/download\//.test(url.pathname)
    )
  } catch {
    return false
  }
}

const TRELLO_UPLOAD_HOSTS = ['trello.com', 'api.trello.com'] as const

export const normaliseTrelloComment = (
  action: TrelloCommentAction,
  cardId?: string,
): NormalisedComment => {
  const edited = action.data.dateLastEdited ?? null
  const shortLink = action.data.card?.shortLink
  const member = action.memberCreator
  const authorId = member?.id ?? action.idMemberCreator ?? null
  return {
    externalId: action.id,
    issueExternalId: action.data.card?.id ?? cardId ?? '',
    body: action.data.text ?? '',
    author: authorId
      ? {
          externalUserId: authorId,
          // Trello never exposes a member's email; the name is what there is.
          displayName: member?.fullName || member?.username || authorId,
        }
      : null,
    createdAt: action.date,
    updatedAt: edited ?? action.date,
    editedAt: edited,
    url: shortLink ? `https://trello.com/c/${shortLink}#comment-${action.id}` : null,
    parentExternalId: null,
  }
}

/**
 * A card's files and links — `file` when Trello holds the upload, `link` when
 * somebody attached a URL — plus uploads referenced inside its description and
 * comments. Trello attaches an image pasted into a comment to the card, so the
 * list already carries most of these; the inline scan only ties them to the
 * text they appear in.
 */
export const trelloAttachments = (
  card: TrelloCard,
  comments: readonly NormalisedComment[] | undefined,
): NormalisedAttachment[] => {
  const createdAt = card.dateLastActivity ?? new Date(0).toISOString()
  const listed: NormalisedAttachment[] = (card.attachments ?? []).map((attachment) => ({
    externalId: attachment.id,
    issueExternalId: card.id,
    url: attachment.url,
    title: attachment.name ?? null,
    contentType: attachment.mimeType ?? null,
    sizeBytes: attachment.bytes ?? null,
    kind: attachment.isUpload ? ('file' as const) : ('link' as const),
    createdAt: attachment.date,
  }))
  const inline = [
    ...inlineAssetsIn(card.desc, TRELLO_UPLOAD_HOSTS, { issueExternalId: card.id, createdAt }),
    ...(comments ?? []).flatMap((comment) =>
      inlineAssetsIn(comment.body, TRELLO_UPLOAD_HOSTS, {
        issueExternalId: card.id,
        commentExternalId: comment.externalId,
        createdAt: comment.createdAt,
      }),
    ),
  ].filter((asset) => isTrelloUploadUrl(asset.url))
  // One file both listed and pasted inline is one asset; the listed entry wins
  // because it carries Trello's id, its size and its type.
  const byUrl = new Map<string, NormalisedAttachment>()
  for (const attachment of [...listed, ...inline]) {
    if (!byUrl.has(attachment.url)) byUrl.set(attachment.url, attachment)
  }
  return [...byUrl.values()]
}

/**
 * A card. `comments` is set only when the read asked for comment actions —
 * `undefined` means "not read on this call", never "there are none".
 */
export const normaliseTrelloCard = (card: TrelloCard, lists: Map<string, string>): NormalisedItem => {
  const comments = card.actions
    ?.filter((action) => !action.type || action.type === 'commentCard')
    .map((action) => normaliseTrelloComment(action, card.id))
  return {
    ...normaliseTrelloCardFields(card, lists),
    ...(comments ? { comments } : {}),
    attachments: trelloAttachments(card, comments),
  }
}

const normaliseTrelloCardFields = (
  card: TrelloCard,
  lists: Map<string, string>,
): NormalisedItem => ({
  externalId: card.id,
  externalKey: card.idShort ? `#${card.idShort}` : card.id.slice(0, 8),
  url: card.url,
  title: card.name,
  description: card.desc,
  stateId: card.idList,
  stateName: lists.get(card.idList) ?? '',
  // Trello cards carry many members; the board shows one assignee, so the
  // first is taken and the rest are left where they are.
  assignee: card.idMembers?.[0]
    ? { externalUserId: card.idMembers[0], displayName: card.idMembers[0] }
    : null,
  priority: null,
  dueDate: card.due ? card.due.slice(0, 10) : null,
  labels: (card.labels ?? []).map(normaliseTrelloLabel),
  // Kept beside the first-class `labels` so a source whose mapping still names
  // the `labels` key fingerprints exactly as before: no mass re-apply.
  fields: { labels: (card.labels ?? []).map((label) => label.id) },
  createdAt: card.dateLastActivity ?? new Date(0).toISOString(),
  updatedAt: card.dateLastActivity ?? new Date(0).toISOString(),
  // Trello calls it "archived"; a closed card has left the board.
  archived: card.closed,
})
