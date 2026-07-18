import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  KnowledgeInferenceOriginError,
  requirePersistedKnowledgeOrigin,
  type KnowledgeVersionIndexedEvent,
} from '@nessie/knowledge'
import {
  attributionFromActorContext,
  completeLedgerAttribution,
  LedgerAttributionError,
} from '@nessie/runtime'
import type {
  AuthorizedActionContext,
  KnowledgeInferenceOrigin,
} from '@nessie/schemas'

type KnowledgeInferenceRequestContext = {
  actorContext?: AuthorizedActionContext
}

const requestContext =
  new AsyncLocalStorage<KnowledgeInferenceRequestContext>()

export const runKnowledgeInferenceRequestContext = <T>(
  operation: () => T,
): T => requestContext.run({}, operation)

export const enterKnowledgeInferenceActorContext = (
  actorContext: AuthorizedActionContext,
): void => {
  const store = requestContext.getStore()
  if (store) {
    store.actorContext = actorContext
    return
  }

  // Production requests are rooted by buildApp's onRequest hook. This fallback
  // keeps separately registered route modules usable in focused tests and
  // embedders that do not construct the full API app.
  requestContext.enterWith({ actorContext })
}

export const withKnowledgeInferenceActorContext = <T>(
  actorContext: AuthorizedActionContext,
  operation: () => T,
): T => requestContext.run({ actorContext }, operation)

export const getKnowledgeInferenceActorContext =
  (): AuthorizedActionContext | undefined =>
    requestContext.getStore()?.actorContext

const originInput = (
  event: KnowledgeVersionIndexedEvent,
  systemComponent: string,
) => ({
  organizationId: event.organizationId,
  pageId: event.pageId,
  systemComponent,
  versionId: event.versionId,
})

const originFromRequest = (
  actorContext: AuthorizedActionContext,
  event: KnowledgeVersionIndexedEvent,
  systemComponent: string,
): KnowledgeInferenceOrigin => {
  if (actorContext.tenant.organizationId !== event.organizationId) {
    throw new KnowledgeInferenceOriginError(
      originInput(event, systemComponent),
    )
  }
  try {
    const attribution = completeLedgerAttribution(
      attributionFromActorContext(actorContext, {
        runId: event.versionId,
        systemComponent,
      }),
    )
    return {
      actorId: attribution.actorId,
      actorType: attribution.actorType ?? 'system',
      agentId: attribution.agentId,
      correlationId: attribution.correlationId ?? undefined,
      requestId:
        attribution.requestId
        ?? `${systemComponent}:${event.versionId}`,
      runId: attribution.runId,
      systemComponent: attribution.systemComponent ?? undefined,
      teamId: attribution.teamId,
      userId: attribution.userId,
    }
  } catch (error) {
    if (error instanceof LedgerAttributionError) {
      throw new KnowledgeInferenceOriginError(
        originInput(event, systemComponent),
      )
    }
    throw error
  }
}

export const requireApiKnowledgeInferenceOrigin = async (
  tx: PrismaClient | Prisma.TransactionClient,
  event: KnowledgeVersionIndexedEvent,
  systemComponent: string,
): Promise<KnowledgeInferenceOrigin> => {
  const actorContext = getKnowledgeInferenceActorContext()
  return actorContext
    ? originFromRequest(actorContext, event, systemComponent)
    : requirePersistedKnowledgeOrigin(
      tx,
      originInput(event, systemComponent),
    )
}
