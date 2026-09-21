import type { TaskSet } from '@prisma/client'
import { attributionFromActorContext, type FileService } from '@nessie/runtime'
import {
  AuthorizedActionContextSchema, TaskSetDisclosureSchema, TaskSetOutputSchema, TaskSetSourceSchema,
  type AuthorizedActionContext, type TaskSetDisclosure,
} from '@nessie/schemas'
import {
  assertTaskSetActor, assertTaskSetDisclosure, authorizeTaskSetOutput, authorizeTaskSetSource,
} from '@nessie/team-admin'
import {
  createNativeKnowledgeProvider, finalizeTaskSetArtifact, type TaskSetArtifactRow,
  TaskSetSourceError,
} from '@nessie/knowledge'
import type { ExecutionDependencies } from '../run/execute/types.js'
import { createConsumedSourceSink } from '../run/execute/disclosure-basis.js'
import { claimTaskSetFinalization, updateTaskSetFinalization, type TaskSetFinalizationClaim } from './finalization-state.js'
import { queueTaskSetDelivery } from './delivery.js'
import { TaskSetBlocked, TaskSetWait } from './state.js'

type Deps = ExecutionDependencies & { fileService: FileService }
const collectDisclosure = () => {
  const sink = createConsumedSourceSink()
  return {
    add(value: unknown) {
      const disclosure = TaskSetDisclosureSchema.parse(value)
      sink.addAll(disclosure.basisScopes)
      for (const source of disclosure.disclosureSources) sink.addPrivateConversationSource(source)
    },
    value: (): TaskSetDisclosure => ({ classified: true,
      basisScopes: sink.list(), disclosureSources: sink.privateConversationSources() }),
  }
}

const authorize = async (deps: Deps, set: TaskSet, actor: AuthorizedActionContext): Promise<void> => {
  await assertTaskSetActor(deps.prisma, actor)
  await assertTaskSetDisclosure(deps.prisma, actor, set.disclosure)
  if (set.source) {
    const source = await authorizeTaskSetSource(deps.prisma, actor, TaskSetSourceSchema.parse(set.source), {
      processingAgentId: set.executionAgentId,
    })
    if (source.attachmentId !== set.sourceAttachmentId) throw new TaskSetBlocked('source_revision_changed')
  }
}

/** Read and validate a bounded page before any row from it reaches an artifact. */
async function* resultRows(
  deps: Deps, claim: TaskSetFinalizationClaim, actor: AuthorizedActionContext,
  all: ReturnType<typeof collectDisclosure>,
): AsyncGenerator<TaskSetArtifactRow> {
  let after = 0
  for (;;) {
    await updateTaskSetFinalization(deps.prisma, claim)
    await authorize(deps, claim.set, actor)
    const page = await deps.prisma.taskSetItem.findMany({
      where: { taskSetId: claim.set.id, sequence: { gt: after } }, orderBy: { sequence: 'asc' }, take: 200,
      select: { id: true, sequence: true, input: true, result: true, status: true,
        disclosure: true, resultDisclosure: true },
    })
    if (!page.length) return
    const basis = collectDisclosure()
    basis.add(claim.set.disclosure)
    for (const row of page) {
      if (!['completed', 'skipped'].includes(row.status)) throw new TaskSetBlocked('result_not_complete')
      if (row.status === 'completed' && (row.result === null || row.resultDisclosure === null)) {
        throw new TaskSetBlocked('result_not_classified')
      }
      basis.add(row.disclosure)
      if (row.resultDisclosure !== null) basis.add(row.resultDisclosure)
    }
    const disclosure = basis.value()
    await assertTaskSetDisclosure(deps.prisma, actor, disclosure)
    all.add(disclosure)
    for (const row of page) {
      after = row.sequence
      yield { id: row.id, sequence: row.sequence, input: row.input, result: row.result, disclosure }
    }
  }
}

export const finalizeTaskSet = async (deps: Deps, id: string): Promise<void> => {
  const claim = await claimTaskSetFinalization(deps.prisma, id)
  if (!claim) return
  const { set } = claim
  const actor = AuthorizedActionContextSchema.parse(set.launchOrigin)
  const all = collectDisclosure()
  all.add(set.disclosure)
  try {
    await authorize(deps, set, actor)
    const output = TaskSetOutputSchema.parse(set.output)
    let outputPageId = set.outputPageId
    if (output.kind !== 'journal') {
      const channel = await deps.prisma.thread.findUniqueOrThrow({
        where: { id: set.executionThreadId }, select: { channel: { select: { teamId: true } } },
      })
      const authorizeDestination = async () => {
        await updateTaskSetFinalization(deps.prisma, claim)
        await authorize(deps, set, actor)
        return authorizeTaskSetOutput(deps.prisma, actor, output, { processingAgentId: set.executionAgentId })
      }
      if (claim.state.receipt) {
        all.add(claim.state.receipt.disclosure)
        await assertTaskSetDisclosure(deps.prisma, actor, all.value())
      }
      const saved = await finalizeTaskSetArtifact({
        prisma: deps.prisma, fileService: deps.fileService, provider: createNativeKnowledgeProvider(deps.prisma),
        authorizeDestination,
        recordReceipt: (receipt) => updateTaskSetFinalization(deps.prisma, claim, { receipt }),
      }, {
        organizationId: set.organizationId, operationKey: `task-set:${set.id}`, title: set.name, output,
        actor: { id: set.executionAgentId, type: 'agent' },
        attribution: { ...attributionFromActorContext(actor, {
          agentId: set.executionAgentId, systemComponent: 'task-set-finalization',
        }), requestId: `task-set:${set.id}:finalization`, teamId: channel.channel.teamId },
        rows: resultRows(deps, claim, actor, all), receipt: claim.state.receipt, disclosure: all.value(),
      })
      outputPageId = saved.pageId
      await updateTaskSetFinalization(deps.prisma, claim, { outputPageId })
      // A recovered existing document does not consume the iterator.
      if (claim.state.receipt) all.add(claim.state.receipt.disclosure)
    } else {
      for await (const row of resultRows(deps, claim, actor, all)) { void row }
    }
    await authorize(deps, set, actor)
    await assertTaskSetDisclosure(deps.prisma, actor, all.value())
    if (set.receiver) {
      await updateTaskSetFinalization(deps.prisma, claim, { disclosure: all.value() })
      const delivery = await queueTaskSetDelivery(deps.prisma, set, all.value(), {
        outputPageId, leaseToken: claim.token,
        retryFailed: claim.state.deliveryFailed === true && set.status === 'running',
      })
      await updateTaskSetFinalization(deps.prisma, claim, {
        deliveryStatus: delivery, deliveryFailed: delivery === 'blocked', release: delivery !== 'delivered',
        finished: delivery === 'delivered',
      })
      if (delivery === 'blocked') throw new TaskSetBlocked('receiver_delivery_failed')
      if (delivery === 'pending') throw new TaskSetWait('receiver_delivery_pending')
    } else await updateTaskSetFinalization(deps.prisma, claim, { finished: true, deliveryStatus: 'none' })
  } catch (error) {
    await updateTaskSetFinalization(deps.prisma, claim, { release: true }).catch(() => undefined)
    if (error instanceof TaskSetSourceError) throw new TaskSetBlocked(error.code)
    throw error
  }
}
