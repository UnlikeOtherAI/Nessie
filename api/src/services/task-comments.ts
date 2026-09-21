import type { PrismaClient } from '@prisma/client'
import type { EncryptionKeyRingInput } from '@nessie/runtime'
import {
  createBoardSourceWriteBack,
  type BoardSourceWriteBack,
  type TaskCommentWriteBack,
} from '@nessie/team-admin'

export {
  createTaskComment,
  deleteTaskComment,
  listTaskComments,
  updateTaskComment,
} from '@nessie/team-admin'

/**
 * The comment half of the board-source write-back collaborator: the same one
 * the task mutations use, so a comment posted by a person and one posted by an
 * agent reach the provider the same way. A method the collaborator does not
 * implement stays absent, which the shared functions read as "this adapter
 * cannot write comments".
 */
export const createTaskCommentWriteBack = (
  prisma: PrismaClient,
  encryptionSecret: EncryptionKeyRingInput,
): TaskCommentWriteBack => {
  const writeBack = createBoardSourceWriteBack({ prisma, encryptionSecret }) as BoardSourceWriteBack
    & TaskCommentWriteBack
  return {
    ...(writeBack.createComment ? { createComment: writeBack.createComment } : {}),
    ...(writeBack.updateComment ? { updateComment: writeBack.updateComment } : {}),
    ...(writeBack.deleteComment ? { deleteComment: writeBack.deleteComment } : {}),
  }
}
