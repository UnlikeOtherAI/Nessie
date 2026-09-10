import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  canUserReadDisclosureBasis,
  type DisclosureAccessPrisma,
} from './disclosure-access.js'

export type RunDisclosurePrisma = DisclosureAccessPrisma & Pick<PrismaClient, 'run' | 'runBasisScope'>

/** May this viewer read material derived from a given run? */
export const canUserReadRunBasis = async (
  prisma: RunDisclosurePrisma,
  input: {
    organizationId: string
    runId: string
    /** Current request/run assertion; explicit undefined for a no-IdP read. */
    uoaIdentity: UoaSessionIdentity | undefined
    userId: string
  },
): Promise<boolean> => {
  const basis = await prisma.runBasisScope.findMany({
    where: { runId: input.runId },
    select: { scopeType: true, scopeId: true },
  })
  if (basis.length === 0) return true

  // A run has no reply relation to join. Its destination channel is therefore
  // the only valid standing-grant destination, and a per-message grant cannot
  // release the reasoning for every run in that channel.
  const run = await prisma.run.findUnique({
    where: { id: input.runId },
    select: { agentId: true, thread: { select: { channelId: true } } },
  })
  if (!run?.thread) return false

  return canUserReadDisclosureBasis(prisma, {
    agentId: run.agentId,
    basis,
    channelId: run.thread.channelId,
    messageId: null,
    organizationId: input.organizationId,
    uoaIdentity: input.uoaIdentity,
    userId: input.userId,
  })
}

/**
 * Tasks, plans, and child-agent summaries can retain the run prompt before a
 * reply exists. They inherit both the run channel entitlement and provenance.
 */
export const canUserReadRunDerivedRecord = async (
  prisma: RunDisclosurePrisma,
  input: {
    organizationId: string
    runId: string | null
    /** Current request/run assertion; explicit undefined for a no-IdP read. */
    uoaIdentity: UoaSessionIdentity | undefined
    userId: string
  },
): Promise<boolean> => {
  if (!input.runId) return true

  const run = await prisma.run.findFirst({
    where: {
      id: input.runId,
      thread: {
        channel: {
          organizationId: input.organizationId,
          OR: [
            { visibility: 'public' },
            { members: { some: { userId: input.userId } } },
          ],
        },
      },
    },
    select: {
      agentId: true,
      id: true,
      thread: { select: { channelId: true } },
      triggerMessage: {
        select: {
          basisScopes: { select: { scopeId: true, scopeType: true } },
          disclosureSources: { select: { sourceAuthorUserId: true, sourceChannelId: true } },
          id: true,
        },
      },
    },
  })
  if (!run) return false

  // A hidden trigger may already carry its private basis while the run is
  // planning and before the durable RunBasisScope is written.
  const trigger = run.triggerMessage
  if (trigger && trigger.basisScopes.length > 0 && !(await canUserReadDisclosureBasis(prisma, {
    agentId: run.agentId,
    basis: trigger.basisScopes,
    channelId: run.thread.channelId,
    disclosureSources: trigger.disclosureSources,
    messageId: trigger.id,
    organizationId: input.organizationId,
    uoaIdentity: input.uoaIdentity,
    userId: input.userId,
  }))) return false

  return canUserReadRunBasis(prisma, {
    organizationId: input.organizationId,
    runId: run.id,
    uoaIdentity: input.uoaIdentity,
    userId: input.userId,
  })
}

/**
 * A search result has no place to carry a run's private basis into a model
 * response. Tool search therefore excludes any run that carries one, even
 * when the acting person could read it, unless the caller explicitly records
 * that provenance before presenting the row.
 */
export const runCarriesDisclosureBasis = async (
  prisma: Pick<PrismaClient, 'run'>,
  runId: string | null,
): Promise<boolean> => {
  if (!runId) return false
  return Boolean(await prisma.run.findFirst({
    where: {
      id: runId,
      OR: [
        { basisScopes: { some: {} } },
        {
          triggerMessage: {
            OR: [
              { basisScopes: { some: {} } },
              { disclosureSources: { some: {} } },
            ],
          },
        },
      ],
    },
    select: { id: true },
  }))
}

/**
 * A tool-search result cannot itself carry channel or run provenance into the
 * model response. Keep that doorway to public, basis-free runs until the tool
 * result has a consumed-source sink that records every returned lineage.
 */
export const runIsSearchSafe = async (
  prisma: Pick<PrismaClient, 'run'>,
  runId: string | null,
): Promise<boolean> => {
  if (!runId) return true
  return Boolean(await prisma.run.findFirst({
    where: {
      id: runId,
      thread: { channel: { visibility: 'public' } },
      NOT: [
        { basisScopes: { some: {} } },
        { triggerMessage: { basisScopes: { some: {} } } },
        { triggerMessage: { disclosureSources: { some: {} } } },
      ],
    },
    select: { id: true },
  }))
}
