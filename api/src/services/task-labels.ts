import type { PrismaClient } from '@prisma/client'
import type { EncryptionKeyRingInput } from '@nessie/runtime'
import { type AuthorizedActionContext, isAdminActor } from '@nessie/schemas'
import {
  createBoardSourceWriteBack,
  setTaskLabels as setTaskLabelsShared,
  type TaskActor,
} from '@nessie/team-admin'

// The label work is shared with the MCP tools and the worker's ticket tools
// in @nessie/team-admin; the route only maps its typed results to statuses.
export {
  createBoardLabel,
  deleteBoardLabel,
  isTaskLabelError,
  listBoardLabels,
  listProjectLabels,
  updateBoardLabel,
} from '@nessie/team-admin'

/** The acting member a route hands the shared ticket functions. */
export const taskActorFromContext = (actorContext: AuthorizedActionContext): TaskActor => ({
  organizationId: actorContext.tenant.organizationId,
  userId: actorContext.actor.actorId,
  isOrganizationAdmin: isAdminActor(actorContext),
})

export const setTaskLabels = (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; labelIds: readonly string[] },
  encryptionSecret: EncryptionKeyRingInput,
) => setTaskLabelsShared(prisma, actor, input, createBoardSourceWriteBack({ prisma, encryptionSecret }))
