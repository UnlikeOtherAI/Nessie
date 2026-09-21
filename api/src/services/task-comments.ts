import type { PrismaClient } from '@prisma/client'
import type { EncryptionKeyRingInput } from '@nessie/runtime'
import {
  createTaskCommentWriteBackFromSource,
  type TaskCommentWriteBack,
} from '@nessie/team-admin'

export {
  createTaskComment,
  deleteTaskComment,
  listTaskComments,
  updateTaskComment,
} from '@nessie/team-admin'

/**
 * The comment half of the board-source write-back collaborator, built by the
 * same team-admin function the worker's agent tools use.
 */
export const createTaskCommentWriteBack = (
  prisma: PrismaClient,
  encryptionSecret: EncryptionKeyRingInput,
): TaskCommentWriteBack => createTaskCommentWriteBackFromSource({ prisma, encryptionSecret })
