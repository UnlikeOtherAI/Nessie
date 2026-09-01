import type { PrismaClient } from '@prisma/client'
import {
  APP_CONNECT_ERROR_CODES,
  AppConnectError,
  connectApp,
  storeCatalogWhere,
  type AppConnectContext,
} from '@nessie/mcp-manage'
import {
  BeginAppConnectionRequestResponseSchema,
  type BeginAppConnectionRequestResponse,
  type AuthorizedActionContext,
} from '@nessie/schemas'

import { getAppConnectionRequestPresenter } from './app-connection-request-presenter.js'

export const APP_CONNECTION_REQUEST_ACTION_ERROR_CODES = {
  NOT_READY: 'APP_CONNECTION_REQUEST_NOT_READY',
  NOT_FOUND: 'APP_CONNECTION_REQUEST_NOT_FOUND',
} as const

export class AppConnectionRequestActionError extends Error {
  constructor(
    readonly code: (typeof APP_CONNECTION_REQUEST_ACTION_ERROR_CODES)[keyof typeof APP_CONNECTION_REQUEST_ACTION_ERROR_CODES],
    message: string,
  ) {
    super(message)
  }
}

const failureCodeFor = (error: unknown): string =>
  error instanceof AppConnectError ? error.code : APP_CONNECT_ERROR_CODES.CONNECTION_FAILED

/**
 * Claim and begin a connection proposed in the current user's PA chat.
 *
 * The compare-and-set happens before any third-party request: a second click
 * cannot select a competing app while the first OAuth attempt is in flight.
 * The subsequent handshake remains the same `connectApp` orchestration as the
 * Apps page, including its existing per-user credential and scope checks.
 */
export const beginAppConnectionRequest = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  requestId: string,
  catalogEntryId: string,
  context: AppConnectContext,
  runConnect: typeof connectApp = connectApp,
): Promise<BeginAppConnectionRequestResponse> => {
  const presenter = await getAppConnectionRequestPresenter(prisma, actorContext, requestId)
  if (!presenter) {
    throw new AppConnectionRequestActionError(
      APP_CONNECTION_REQUEST_ACTION_ERROR_CODES.NOT_FOUND,
      'App connection request not found',
    )
  }
  if (
    presenter.status !== 'offered'
    || presenter.action !== 'begin'
    || !presenter.candidates.some((candidate) => candidate.catalogEntryId === catalogEntryId)
  ) {
    throw new AppConnectionRequestActionError(
      APP_CONNECTION_REQUEST_ACTION_ERROR_CODES.NOT_READY,
      'This app connection request can no longer be started.',
    )
  }

  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`app-connect:${actorContext.actor.actorId}:${requestId}`}, 0)
      )
    `
    // Re-read inside the lock. A concurrent tab, expiry or early-access
    // change is never allowed to reuse a stale pre-click presenter.
    const current = await getAppConnectionRequestPresenter(
      tx as unknown as PrismaClient,
      actorContext,
      requestId,
    )
    if (
      !current
      || current.status !== 'offered'
      || current.action !== 'begin'
      || !current.candidates.some((candidate) => candidate.catalogEntryId === catalogEntryId)
    ) {
      return false
    }
    // The stored snapshot proves the person saw and selected this app; it is
    // not a continuing entitlement. Re-check current store visibility and the
    // catalogue's operational state immediately before the compare-and-set.
    const liveEntry = await tx.mcpCatalogEntry.findFirst({
      where: {
        AND: [
          storeCatalogWhere(actorContext),
          {
            id: catalogEntryId,
            locked: false,
            status: { not: 'deprecated' },
          },
        ],
      },
      select: { id: true },
    })
    if (!liveEntry) return false
    const updated = await tx.agentAppConnectionRequest.updateMany({
      where: {
        expiresAt: { gt: new Date() },
        id: requestId,
        organizationId: actorContext.tenant.organizationId,
        requestedByUserId: actorContext.actor.actorId,
        selectedCatalogEntryId: null,
        status: 'offered',
      },
      data: {
        scopeId: actorContext.actor.actorId,
        scopeType: 'user',
        selectedCatalogEntryId: catalogEntryId,
        status: 'connecting',
      },
    })
    return updated.count === 1
  })
  if (!claimed) {
    throw new AppConnectionRequestActionError(
      APP_CONNECTION_REQUEST_ACTION_ERROR_CODES.NOT_READY,
      'This app connection request is already being handled.',
    )
  }

  try {
    const { outcome } = await runConnect(context, {
      identifier: catalogEntryId,
      scopeId: actorContext.actor.actorId,
      scopeType: 'user',
    })
    const status = outcome.status === 'connected'
      ? 'awaiting_grant'
      : outcome.status === 'needs_secret'
        ? 'needs_secret'
        : 'connecting'
    await prisma.agentAppConnectionRequest.updateMany({
      where: {
        id: requestId,
        organizationId: actorContext.tenant.organizationId,
        requestedByUserId: actorContext.actor.actorId,
        selectedCatalogEntryId: catalogEntryId,
        status: 'connecting',
      },
      // The database constraint binds a populated instance id to its backend;
      // keep the durable request self-describing before the callback arrives.
      data: {
        connectionBackend: 'mcp',
        mcpInstanceId: outcome.connectionId,
        status,
      },
    })
    return BeginAppConnectionRequestResponseSchema.parse(
      outcome.status === 'authorize'
        ? { authorizationUrl: outcome.authorizationUrl, status: outcome.status }
        : { status: outcome.status },
    )
  } catch (error) {
    await prisma.agentAppConnectionRequest.updateMany({
      where: {
        id: requestId,
        organizationId: actorContext.tenant.organizationId,
        requestedByUserId: actorContext.actor.actorId,
        selectedCatalogEntryId: catalogEntryId,
        status: 'connecting',
      },
      data: { failureCode: failureCodeFor(error), status: 'failed' },
    })
    throw error
  }
}
