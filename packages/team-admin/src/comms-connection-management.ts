import { Prisma, type CommsProvider, type PrismaClient } from '@prisma/client'
import { resolveConnector } from '@nessie/comms-connect'
import { enqueueQueueJob } from '@nessie/db'
import {
  COMMS_SYNC_INCREMENTAL_TOPIC,
  COMMS_SYNC_INITIAL_TOPIC,
} from '@nessie/schemas'

import { buildCommsConnectorContext } from './comms-credential-coordinator.js'

type CommsConnectionRow = Prisma.CommsConnectionGetPayload<object>

export type OwnedCommsConnection = {
  connection: CommsConnectionRow
  resourceCount: number
  syncedResourceCount: number
}

export type CommsConnectionManagementErrorCode =
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_DISCONNECTED'

export class CommsConnectionManagementError extends Error {
  constructor(readonly code: CommsConnectionManagementErrorCode) {
    super(
      code === 'CONNECTION_NOT_FOUND'
        ? 'That connected account was not found.'
        : 'That connected account is disconnected.',
    )
    this.name = 'CommsConnectionManagementError'
  }
}

const ownedWhere = (input: {
  organizationId: string
  userId: string
}): Prisma.CommsConnectionWhereInput => ({
  organizationId: input.organizationId,
  ownerUserId: input.userId,
})

/** Every provider connection owned by this person in this organisation. */
export const listOwnedCommsConnections = async (
  prisma: PrismaClient,
  input: { organizationId: string; userId: string },
): Promise<OwnedCommsConnection[]> => {
  const connections = await prisma.commsConnection.findMany({
    orderBy: { createdAt: 'desc' },
    where: ownedWhere(input),
  })
  const ids = connections.map((connection) => connection.id)
  if (ids.length === 0) return []

  const [totals, synced] = await Promise.all([
    prisma.commsResource.groupBy({
      _count: { _all: true },
      by: ['connectionId'],
      where: { connectionId: { in: ids } },
    }),
    prisma.commsResource.groupBy({
      _count: { _all: true },
      by: ['connectionId'],
      where: { connectionId: { in: ids }, syncEnabled: true },
    }),
  ])
  const totalById = new Map(totals.map((row) => [row.connectionId, row._count._all]))
  const syncedById = new Map(synced.map((row) => [row.connectionId, row._count._all]))
  return connections.map((connection) => ({
    connection,
    resourceCount: totalById.get(connection.id) ?? 0,
    syncedResourceCount: syncedById.get(connection.id) ?? 0,
  }))
}

/** One provider connection, with the same ownership predicate as the list. */
export const loadOwnedCommsConnection = async (
  prisma: PrismaClient,
  input: { connectionId: string; organizationId: string; userId: string },
): Promise<CommsConnectionRow> => {
  const connection = await prisma.commsConnection.findFirst({
    where: { id: input.connectionId, ...ownedWhere(input) },
  })
  if (!connection) {
    throw new CommsConnectionManagementError('CONNECTION_NOT_FOUND')
  }
  return connection
}

/** Queue the same initial/incremental sync used by the connection settings UI. */
export const queueOwnedCommsConnectionSync = async (
  prisma: PrismaClient,
  input: { connectionId: string; organizationId: string; userId: string },
): Promise<{ connection: CommsConnectionRow; phase: 'initial' | 'incremental' }> => {
  const connection = await loadOwnedCommsConnection(prisma, input)
  if (connection.status === 'disconnected') {
    throw new CommsConnectionManagementError('CONNECTION_DISCONNECTED')
  }
  const phase = connection.initialSyncCompletedAt ? 'incremental' : 'initial'
  const topic = phase === 'incremental'
    ? COMMS_SYNC_INCREMENTAL_TOPIC
    : COMMS_SYNC_INITIAL_TOPIC
  await enqueueQueueJob(prisma, {
    payload: { connectionId: connection.id },
    topic,
  })
  return { connection, phase }
}

/**
 * Revoke remotely when possible, then always sever the local credential.
 * Provider failure is diagnostic only: leaving a live local token behind would
 * contradict the person's disconnect action.
 */
export const disconnectOwnedCommsConnection = async (
  prisma: PrismaClient,
  input: {
    connectionId: string
    encryptionSecret: string
    organizationId: string
    userId: string
  },
  options: { onProviderRevokeError?: (error: unknown) => void } = {},
): Promise<{ connectionId: string; provider: CommsProvider }> => {
  const connection = await prisma.commsConnection.findFirst({
    include: { credential: true },
    where: { id: input.connectionId, ...ownedWhere(input) },
  })
  if (!connection) {
    throw new CommsConnectionManagementError('CONNECTION_NOT_FOUND')
  }

  if (connection.credential) {
    try {
      const connector = resolveConnector(connection.provider)
      await connector.disconnect(
        buildCommsConnectorContext(connection, input.encryptionSecret),
      )
    } catch (error) {
      options.onProviderRevokeError?.(error)
    }
  }

  await prisma.$transaction([
    prisma.commsConnectionCredential.deleteMany({
      where: { connectionId: connection.id },
    }),
    prisma.commsConnection.update({
      data: { status: 'disconnected' },
      where: { id: connection.id },
    }),
  ])
  return { connectionId: connection.id, provider: connection.provider }
}
