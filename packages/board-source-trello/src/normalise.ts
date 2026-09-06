import type { NormalisedItem } from '@nessie/board-sources'

export type TrelloCard = {
  id: string
  idShort?: number
  name: string
  desc: string | null
  url: string
  closed: boolean
  idList: string
  idMembers?: string[]
  labels?: { id: string; name: string }[]
  due?: string | null
  dateLastActivity?: string
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

export const normaliseTrelloCard = (
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
  labels: (card.labels ?? []).map((label) => ({ id: label.id, label: label.name })),
  fields: { labels: (card.labels ?? []).map((label) => label.id) },
  createdAt: card.dateLastActivity ?? new Date(0).toISOString(),
  updatedAt: card.dateLastActivity ?? new Date(0).toISOString(),
  // Trello calls it "archived"; a closed card has left the board.
  archived: card.closed,
})
