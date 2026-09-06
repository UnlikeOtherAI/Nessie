import { z } from 'zod'

/**
 * A ticket pointer on a message, so a board's card can be shown in chat.
 *
 * Modelled exactly on `DashboardPresentationMessageMetadataSchema`, including
 * the reason: the message carries an **id**, never a rendered card or the
 * ticket's own fields. The client reads the task back through its normal
 * viewer-scoped endpoint, so a ticket appearing in a conversation never grants
 * anybody access to it — and a person who loses access stops seeing it without
 * anything having to remember to rewrite the message.
 *
 * Deliberately **not** an `AgentCard`. That system exists for cards a person
 * presses, and its closed block vocabulary is what stops a `kind` per
 * integration. A watcher notification has no press, so it is an ordinary
 * message with a pointer — and the board's own card component draws it, which
 * is the same "one drawing" answer without amending a standard.
 */
export const TaskPresentationMessageMetadataSchema = z
  .object({
    taskPresentation: z
      .object({
        taskId: z.string().uuid(),
        /** The board the telling came from, so the card can link back to it. */
        boardId: z.string().uuid().optional(),
        /** What moved. Renders as the one-line reason above the card. */
        changes: z.enum(['status', 'assignee']).array().max(2).optional(),
        schemaVersion: z.literal(1),
      })
      .strict(),
  })
  .strict()

export type TaskPresentationMessageMetadata = z.infer<
  typeof TaskPresentationMessageMetadataSchema
>
