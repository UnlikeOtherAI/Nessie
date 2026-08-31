import { Prisma } from '@prisma/client'

/** Serializes every state transition that can race on one to-do. */
export const acquireAgentTodoLock = async (
  tx: Prisma.TransactionClient,
  todoId: string,
): Promise<void> => {
  await tx.$executeRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${todoId}, 0))
    `,
  )
}
