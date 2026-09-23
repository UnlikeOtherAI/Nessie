import type { PrismaClient } from '@prisma/client'
import {
  agentCoreTokenBudget,
  canReadKnowledgePageVersion,
  canReadSpace,
  coreDocumentFilename,
  createNativeKnowledgeProvider,
  ensureCanonicalAgentCore,
  estimateAgentCoreTokens,
  loadActiveAgentCoreDocuments,
  loadSpaceViewer,
  readCanonicalMarkdownAttachment,
} from '@nessie/knowledge'
import { attributionFromActorContext, resolveLiveEntitlements } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { fileServiceFor } from '../file-service.js'
import {
  recordKnowledgeSpaceRead,
  recordKnowledgeVersionRead,
} from '../pa-tools/knowledge-basis.js'
import { createConsumedSourceSink } from './disclosure-basis.js'
import { resolveDisclosureViewer } from './disclosure-viewer.js'
import type { RunContext } from './types.js'

type CoreAdmissionRun = {
  agent: {
    agentKind: 'personal_assistant' | 'shared'
    id: string
    ownerUserId: string | null
    parentAgentId: string | null
    systemManaged: boolean
  }
  coreDocumentCount: number
  coreDocumentsAdmittedAt: Date | null
  id: string
}

type CoreAdmissionResult = Pick<RunContext, 'consumedSources' | 'coreDocuments'>

/**
 * Provisions an ordinary agent's required files, pins their exact revisions to
 * the run, and reauthorizes every pinned source before opening any bytes. A
 * resumed run therefore cannot bypass a later entitlement revocation, while a
 * concurrent edit cannot mutate the instructions this run already admitted.
 */
export const admitRunAgentCore = async (input: {
  organizationId: string
  payload: RunExecuteJobPayload
  prisma: PrismaClient
  run: CoreAdmissionRun
}): Promise<CoreAdmissionResult> => {
  const { organizationId, payload, prisma, run } = input
  const sourceAgentId = run.agent.parentAgentId ?? run.agent.id
  const sourceSystemManaged = run.agent.parentAgentId
    ? (await prisma.agent.findFirst({
        where: { id: run.agent.parentAgentId, organizationId },
        select: { systemManaged: true },
      }))?.systemManaged === true
    : run.agent.systemManaged
  const consumedSources = createConsumedSourceSink()

  // App-provided agents expose code-owned read-only projections rather than
  // tenant-authored knowledge files. Never let stray mappings override that
  // blueprint contract; prompt assembly reads the row's projected AGENTS.md
  // and personality.md values through its labelled fallback.
  if (sourceSystemManaged) {
    if (!run.coreDocumentsAdmittedAt) {
      await prisma.run.update({
        where: { id: run.id },
        data: { coreDocumentCount: 0, coreDocumentsAdmittedAt: new Date() },
      })
    }
    return { consumedSources, coreDocuments: [] }
  }

  const files = fileServiceFor(prisma)
  const provider = createNativeKnowledgeProvider(prisma, {
    readMarkdownAttachment: async (attachmentId, tenantId) => {
      const opened = await files.openStream(attachmentId, tenantId)
      return opened?.stream ?? null
    },
  })

  // Creation can be interrupted after the agent row commits, and an older
  // marker-zero cutover can be incomplete. Run admission repairs either state
  // before selecting the immutable snapshot.
  if (!run.coreDocumentsAdmittedAt && !sourceSystemManaged) {
    await ensureCanonicalAgentCore(prisma, provider, files, {
      agentId: sourceAgentId,
      attribution: attributionFromActorContext(payload.actorContext, {
        agentId: run.agent.id,
        agentKind: run.agent.agentKind,
        runId: run.id,
      }),
      authorId: run.agent.id,
      authorType: 'agent',
      organizationId,
      provisionOnly: true,
      uploaderId: run.agent.ownerUserId,
    })
  }

  let coreViewers: Promise<{
    disclosureViewer: Awaited<ReturnType<typeof resolveDisclosureViewer>>
    spaceViewer: Awaited<ReturnType<typeof loadSpaceViewer>>
  }> | undefined
  const resolveCoreViewers = () => {
    coreViewers ??= (async () => {
      const effectiveUserId = payload.actorContext.actionContext.effectiveUserId
        ?? (payload.actorContext.actor.actorType === 'user'
          ? payload.actorContext.actor.actorId
          : undefined)
      const liveEntitlements = effectiveUserId
        ? await resolveLiveEntitlements(prisma, {
            organizationId,
            uoaIdentity: payload.actorContext.actionContext.uoaIdentity,
            userId: effectiveUserId,
          })
        : undefined
      const [spaceViewer, disclosureViewer] = await Promise.all([
        loadSpaceViewer(prisma, organizationId, {
          actorId: run.agent.id,
          actorType: 'agent',
        }, {
          ...(effectiveUserId ? { effectiveUserId } : {}),
          ...(liveEntitlements ? { liveEntitlements } : {}),
        }),
        resolveDisclosureViewer(prisma, payload, organizationId, liveEntitlements),
      ])
      return { disclosureViewer, spaceViewer }
    })()
    return coreViewers
  }
  const authorizeCoreRead = async (document: {
    basisScopes: Array<{ scopeId: string; scopeType: string }>
    disclosureSources: Array<{ sourceAuthorUserId: string | null; sourceChannelId: string }>
    spaceId: string
  }) => {
    const { disclosureViewer, spaceViewer } = await resolveCoreViewers()
    const space = await provider.getSpace(organizationId, document.spaceId)
    if (
      !space
      || space.ownerAgentId !== sourceAgentId
      || !canReadSpace(space, spaceViewer)
    ) {
      throw new Error('An agent core instruction home was deleted or is no longer readable')
    }
    if (!canReadKnowledgePageVersion(document, disclosureViewer)) {
      throw new Error('An agent core instruction source was revoked or is no longer readable')
    }
    // Stamp the source before opening bytes, matching an on-demand page read.
    recordKnowledgeSpaceRead({ consumedSources }, [space])
    recordKnowledgeVersionRead({ consumedSources }, document)
    return space
  }

  let admittedCoreDocumentCount = run.coreDocumentCount
  if (!run.coreDocumentsAdmittedAt) {
    const admittedCore = await loadActiveAgentCoreDocuments(prisma, {
      agentId: sourceAgentId,
      authorize: async (document) => { await authorizeCoreRead(document) },
      organizationId,
      readMarkdownAttachment: async (attachmentId, tenantId) => {
        const opened = await files.openStream(attachmentId, tenantId)
        return opened?.stream ?? null
      },
    })
    if (!sourceSystemManaged && admittedCore.length !== 2) {
      throw new Error('Every ordinary agent requires AGENTS.md and personality.md before a run can start')
    }
    const estimate = estimateAgentCoreTokens(admittedCore)
    if (estimate > agentCoreTokenBudget()) {
      throw new Error(
        `Core instructions estimate ${estimate} tokens, above the ${agentCoreTokenBudget()} token limit; `
        + 'shorten AGENTS.md or personality.md before starting a new run',
      )
    }
    await prisma.runCoreDocumentSnapshot.createMany({
      data: admittedCore.map((document) => ({
        role: document.role,
        runId: run.id,
        versionId: document.versionId,
      })),
      skipDuplicates: true,
    })
    await prisma.run.update({
      where: { id: run.id },
      data: { coreDocumentCount: admittedCore.length, coreDocumentsAdmittedAt: new Date() },
    })
    admittedCoreDocumentCount = admittedCore.length
  }

  const coreSnapshots = await prisma.runCoreDocumentSnapshot.findMany({
    where: { runId: run.id },
    orderBy: { role: 'asc' },
    select: {
      role: true,
      version: {
        select: {
          attachmentId: true,
          basisScopes: { select: { scopeId: true, scopeType: true } },
          disclosureSources: {
            select: { sourceAuthorUserId: true, sourceChannelId: true },
          },
          id: true,
          page: {
            select: {
              coreDocumentFor: { select: { agentId: true, role: true } },
              deletedAt: true,
              documentRole: true,
              kind: true,
              parentPageId: true,
              projectId: true,
              sensitivityTier: true,
              spaceId: true,
              title: true,
              visibility: true,
            },
          },
          sourceContentHash: true,
        },
      },
    },
  })
  if (coreSnapshots.length !== admittedCoreDocumentCount) {
    throw new Error('A core instruction source was deleted or revoked; start a new run after resolving it')
  }
  const coreDocuments = await Promise.all(coreSnapshots.map(async (snapshot) => {
    const page = snapshot.version.page
    if (
      page.deletedAt
      || page.kind !== 'file'
      || page.documentRole !== snapshot.role
      || page.parentPageId !== null
      || page.title !== coreDocumentFilename(snapshot.role)
      || page.coreDocumentFor?.agentId !== sourceAgentId
      || page.coreDocumentFor?.role !== snapshot.role
    ) {
      throw new Error(`Core snapshot ${snapshot.role} is no longer a canonical required file`)
    }
    if (!snapshot.version.attachmentId || !snapshot.version.sourceContentHash) {
      throw new Error(`Core snapshot ${snapshot.role} has no canonical Markdown source`)
    }
    const space = await authorizeCoreRead({
      basisScopes: snapshot.version.basisScopes,
      disclosureSources: snapshot.version.disclosureSources,
      spaceId: page.spaceId,
    })
    if (
      page.projectId !== space.projectId
      || page.sensitivityTier !== space.sensitivityTier
      || page.visibility !== space.visibility
    ) {
      throw new Error(`Core snapshot ${snapshot.role} no longer inherits its document home scope`)
    }
    const source = await readCanonicalMarkdownAttachment(async (attachmentId, tenantId) => {
      const opened = await files.openStream(attachmentId, tenantId)
      return opened?.stream ?? null
    }, snapshot.version.attachmentId, organizationId)
    if (source.sourceContentHash !== snapshot.version.sourceContentHash) {
      throw new Error(`Core snapshot ${snapshot.role} no longer matches its approved version`)
    }
    return { markdown: source.content, role: snapshot.role, versionId: snapshot.version.id }
  }))
  const estimate = estimateAgentCoreTokens(coreDocuments)
  if (estimate > agentCoreTokenBudget()) {
    throw new Error(
      `Core instructions estimate ${estimate} tokens, above the ${agentCoreTokenBudget()} token limit; `
      + 'shorten AGENTS.md or personality.md before resuming this run',
    )
  }

  return { consumedSources, coreDocuments }
}
