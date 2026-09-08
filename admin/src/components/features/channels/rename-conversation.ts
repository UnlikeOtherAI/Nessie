/**
 * Renaming the conversation you are reading.
 *
 * A conversation's title is text somebody chose — the caller's title, or the
 * first line of the opening message — and it is renamable by whoever started
 * it or can manage the room it lives in
 * (docs/plans/2026-09-08-agent-conversations.md → "Titles are text, not
 * intent"). `PATCH /api/threads/:threadId` has always accepted the rename and
 * `useRenameThread` has always been wired to it; until this module there was
 * no control anywhere that reached either, which is the gap Rule zero names.
 *
 * The doorway is the conversation header, because that is where the title is
 * being read. The rule and the action live here rather than inside
 * `ChannelHeader` so both can be pinned without a DOM, exactly as the agent
 * tools' doorway is (`tool-rail/chat-tools.ts`).
 */

import { faPen } from '@fortawesome/free-solid-svg-icons'
import { CONVERSATION_TITLE_MAX_CHARS } from '@nessie/schemas'
import type { PageHeaderAction } from '../../shared/ResponsivePageHeader'

export const RENAME_CONVERSATION_ACTION_ID = 'rename-conversation'

/**
 * Below the favourite star (90) and above the room's own controls (info,
 * members, settings). Deliberately not `primary`: the agent's tool doorways
 * are the controls that must survive every width, and a rename that pushed
 * one of them into "More" would trade a doorway for a doorway.
 */
export const RENAME_CONVERSATION_ACTION_PRIORITY = 85

/** The two facts the rule reads off the conversation record. */
export type RenameableConversation = {
  isGeneral: boolean
  startedByUserId: string | null
}

export type ConversationRenameDoorway = {
  /** The open conversation, or null in a room's General thread. */
  conversation: RenameableConversation | null
  onRename: () => void
  /** `viewerCanManage` on the channel row the conversation lives in. */
  viewerCanManageChannel: boolean
  /** The signed-in person, or null before the session has resolved. */
  viewerUserId: string | null
}

/**
 * Who may rename: the person who started the conversation, or anyone who can
 * manage its room. A room's General thread is the room and carries its name,
 * so it is never renamable here — the server says the same thing with
 * `THREAD_TITLE_FIXED`, and this only keeps the doorway from offering a
 * refusal.
 */
export const mayRenameConversation = ({
  conversation,
  viewerCanManageChannel,
  viewerUserId,
}: Omit<ConversationRenameDoorway, 'onRename'>): boolean => {
  if (conversation === null || conversation.isGeneral) return false
  const startedByViewer =
    viewerUserId !== null && conversation.startedByUserId === viewerUserId
  return startedByViewer || viewerCanManageChannel
}

/**
 * The rename as conversation-header data — one action, or none. It joins the
 * `PageHeaderAction[]` the header already builds, so it obeys the same
 * overflow policy as every other control there and never becomes a second bar.
 */
export const renameConversationHeaderActions = (
  doorway: ConversationRenameDoorway | null,
): PageHeaderAction[] =>
  doorway !== null && mayRenameConversation(doorway)
    ? [
        {
          compact: true,
          icon: faPen,
          id: RENAME_CONVERSATION_ACTION_ID,
          label: 'Rename',
          onSelect: doorway.onRename,
          priority: RENAME_CONVERSATION_ACTION_PRIORITY,
          title: 'Rename this conversation',
        },
      ]
    : []

/**
 * When Save commits something. The server trims and holds the same 1–80 bound
 * (`RenameThreadBodySchema`), so the comparison is between trimmed values:
 * adding a trailing space is not a rename, and a title that is only whitespace
 * is not a title.
 */
export const canSaveConversationTitle = ({
  current,
  next,
  pending,
}: {
  current: string
  next: string
  pending: boolean
}): boolean => {
  if (pending) return false
  const trimmed = next.trim()
  if (trimmed.length === 0 || trimmed.length > CONVERSATION_TITLE_MAX_CHARS) return false
  return trimmed !== current.trim()
}
