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

/** Serializes competing start requests for the same executing run. */
export const acquireAgentTodoRunLock = async (
  tx: Prisma.TransactionClient,
  runId: string,
): Promise<void> => {
  await tx.$executeRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`run:${runId}`}, 0))
    `,
  )
}

/** Serializes the bounded set of pending agent proposals for one agent. */
export const acquireAgentTodoAgentLock = async (
  tx: Prisma.TransactionClient,
  agentId: string,
): Promise<void> => {
  await tx.$executeRaw(
    Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${`agent-todo:${agentId}`}, 0))
    `,
  )
}
