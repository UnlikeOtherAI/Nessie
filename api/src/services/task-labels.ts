import type { PrismaClient } from '@prisma/client'
import type { EncryptionKeyRingInput } from '@nessie/runtime'
import { type AuthorizedActionContext, isAdminActor, type TaskEventOrigin } from '@nessie/schemas'
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

/**
 * The acting member a route hands the shared ticket functions. `origin` is the
 * credential the request authenticated with (`taskEventOriginFor`), or the MCP
 * credential; absent, the events it writes are `system` and start nothing.
 */
export const taskActorFromContext = (
  actorContext: AuthorizedActionContext,
  origin?: TaskEventOrigin,
): TaskActor => ({
  organizationId: actorContext.tenant.organizationId,
  userId: actorContext.actor.actorId,
  isOrganizationAdmin: isAdminActor(actorContext),
  ...(origin ? { origin } : {}),
})

export const setTaskLabels = (
  prisma: PrismaClient,
  actor: TaskActor,
  input: { taskId: string; labelIds: readonly string[] },
  encryptionSecret: EncryptionKeyRingInput,
) => setTaskLabelsShared(prisma, actor, input, createBoardSourceWriteBack({ prisma, encryptionSecret }))
