import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import type { PrismaClient } from '@prisma/client'
import {
  confirmExecutorAccessChange,
  executorCodingSessionOwnerKey,
  ExecutorError,
  prepareExecutorAccessChange,
  rejectExecutorAccessChange,
  standingPolicyTermsDigest,
} from '@nessie/executor-manage'
import { AgentCardSpecSchema, ticketWorkCodingSessionContext } from '@nessie/schemas'

import { applyExecutorAccessChangeEffects, applyRejectedExecutorAccessChangeEffects } from '../src/executor-access-change-effects.js'
import { standingPolicyTriggerEditSentence } from '../src/standing-policy-trigger-edit.js'
import { StandingPolicyRefusal } from '../src/standing-policy-trigger.js'
import { deleteAgentTrigger, updateAgentTrigger } from '../src/trigger-lifecycle.js'
import { seedStandingPolicyWorld, testPrisma, type StandingPolicyWorld } from './standing-policy-fixture.js'

/**
 * Standing machine access against Postgres (docs/standards/ticket-work.md;
 * docs/plans/2026-09-23-ticket-driven-agents/machine-access.md): prepared only
 * by the trigger's author for machines that qualify, each other machine
 * refused with its reason; one confirmation applying every machine's
 * assignment, grant and tool enablement and the policy atomically; every
 * pinned field's edit suspending it and a lowered limit not; a descriptor
 * review suspending it; a disable or delete ending it; a re-confirmation
 * requeueing the tickets that waited; and an audit row for each.
 */

const dbTest = process.env.DATABASE_URL ? test : test.skip

const withWorld = async (run: (world: StandingPolicyWorld, prisma: PrismaClient) => Promise<void>): Promise<void> => {
  const prisma = testPrisma()
  const world = await seedStandingPolicyWorld(prisma)
  try {
    await run(world, prisma)
  } finally {
    try { await world.cleanup() } finally { await prisma.$disconnect() }
  }
}

const refusal = async (promise: Promise<unknown>): Promise<StandingPolicyRefusal> => {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof StandingPolicyRefusal, `expected a refusal, got ${String(error)}`)
    return error
  }
  throw new Error('expected the prepare to be refused')
}

const policyOf = (prisma: PrismaClient, id: string) => prisma.executorStandingPolicy.findUniqueOrThrow({
  where: { id }, include: { executors: { orderBy: { position: 'asc' } } },
})

const auditActions = async (prisma: PrismaClient, policyId: string): Promise<string[]> =>
  (await prisma.auditLog.findMany({
    where: { resourceId: policyId, resourceType: 'executor_standing_policy' },
    orderBy: { createdAt: 'asc' },
    select: { action: true },
  })).map((row) => row.action)

/** A live policy on these machines. */
const confirmed = async (world: StandingPolicyWorld, executorIds: string[], extra: Record<string, unknown> = {}) => {
  const prepared = await world.prepare({ executorIds, ...extra })
  await world.confirm(prepared)
  return prepared.policyId
}

dbTest('only the trigger\'s author may prepare, and a stranger to the organisation finds no trigger', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const byColleague = await refusal(world.prepare({ executorIds: [minis] }, world.contextFor(world.colleagueId)))
    assert.match(byColleague.message, /Only Ondrej, who set this trigger up, can set up machine access for it/)
    assert.match(byColleague.message, /Ask Ondrej to set it up/)
    // Not even an organisation owner stands in for the author.
    await refusal(world.prepare({ executorIds: [minis] }, world.contextFor(world.ownerId)))
    const elsewhere = await refusal(world.prepare({ executorIds: [minis] }, {
      ...world.authorContext, tenant: { organizationId: randomUUID() },
    } as never))
    assert.equal(elsewhere.message, 'Trigger not found.')
    assert.equal(await prisma.executorStandingPolicy.count({ where: { triggerId: world.triggerId } }), 0)
  })
})

dbTest('each machine that cannot take the work is refused with its reason, and nothing is prepared', async () => {
  await withWorld(async (world, prisma) => {
    const good = await world.machine({ label: 'Minis' })
    const cases: Array<[string, RegExp, Promise<string>]> = [
      ['not_private', /Shared is shared with the whole organisation/, world.machine({ label: 'Shared', scope: 'organization' })],
      ['paired_by_someone_else', /Theirs was paired by someone else/,
        world.machine({ label: 'Theirs', pairedBy: world.colleagueId })],
      ['no_reviewed_coding_sessions', /Bare has no reviewed coding-sessions bridge/,
        world.machine({ codingSessions: null, label: 'Bare' })],
      ['offline', /Asleep is offline/, world.machine({ label: 'Asleep', status: 'offline' })],
      ['older_executor', /Old's executor is too old/, world.machine({
        codingSessions: {
          agents: ['claude'], allowedToolCount: 0, configDigest: `sha256:${'b'.repeat(64)}`, environmentNames: [],
          permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
        },
        label: 'Old',
      })],
      ['no_turn_budget', /Codexy offers only Codex, which has no per-turn spending limit/, world.machine({
        codingSessions: {
          agents: ['codex'], allowedToolCount: 0, configDigest: `sha256:${'b'.repeat(64)}`, environmentNames: [],
          maxBudgetUsd: { codex: null }, maxLiveSessionsPerOwner: 3, mergeCommands: [],
          permissionMode: { codex: 'fullAuto' }, rootNames: ['nessie'], serverName: 'coding-sessions',
        },
        label: 'Codexy',
      })],
      ['turn_budget_above_ticket', /Claude Code on Spendy may spend \$50 a turn, more than the \$20 a ticket may spend/,
        world.machine({
          codingSessions: {
            agents: ['claude'], allowedToolCount: 0, configDigest: `sha256:${'b'.repeat(64)}`, environmentNames: [],
            maxBudgetUsd: { claude: 50 }, maxLiveSessionsPerOwner: 3, mergeCommands: [],
            permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
          },
          label: 'Spendy',
        })],
    ]
    for (const [reason, sentence, pending] of cases) {
      const refused = await refusal(world.prepare({ executorIds: [good, await pending] }))
      assert.match(refused.message, /Not every machine you named can take this trigger's work/)
      assert.match(refused.message, sentence)
      assert.deepEqual(refused.machines.map((machine) => machine.reason), [reason])
    }
    const roots = await refusal(world.prepare({ allowedRootNames: ['elsewhere'], executorIds: [good] }))
    assert.match(roots.message, /Minis has no coding root named elsewhere \(it has nessie, web\)/)
    assert.equal(await prisma.executorStandingPolicy.count({ where: { triggerId: world.triggerId } }), 0)
    assert.equal(await prisma.executorContinuation.count({ where: { executorId: good } }), 0)
  })
})

dbTest('a bypass-mode Claude Code needs the separate option ticked', async () => {
  await withWorld(async (world) => {
    const yolo = await world.machine({
      codingSessions: {
        agents: ['claude'], allowedToolCount: 0, configDigest: `sha256:${'d'.repeat(64)}`, environmentNames: [],
        maxBudgetUsd: { claude: 5 }, maxLiveSessionsPerOwner: 3,
        mergeCommands: ['git push', 'gh pr create', 'gh pr checks', 'gh pr merge'],
        permissionMode: { claude: 'bypassPermissions' }, rootNames: ['nessie'], serverName: 'coding-sessions',
      },
      label: 'Yolo',
    })
    const refused = await refusal(world.prepare({ executorIds: [yolo] }))
    assert.deepEqual(refused.machines.map((machine) => machine.reason), ['bypass_not_allowed'])
    assert.match(refused.message, /Let the coding agent run any command without asking\./)
    const prepared = await world.prepare({ allowAnyCommand: true, executorIds: [yolo] })
    const card = AgentCardSpecSchema.parse(prepared.card)
    assert.match(JSON.stringify(card.blocks), /Any, without asking: you chose/)
  })
})

dbTest('one confirmation applies each machine\'s assignment, grant and tools and the policy, and pins what it showed', async () => {
  await withWorld(async (world, prisma) => {
    const [minis, studio] = [await world.machine({ label: 'Minis' }), await world.machine({
      codingSessions: {
        agents: ['claude'], allowedToolCount: 1, configDigest: `sha256:${'e'.repeat(64)}`, environmentNames: [],
        maxBudgetUsd: { claude: 4 }, maxLiveSessionsPerOwner: 2, mergeCommands: ['git push'],
        permissionMode: { claude: 'acceptEdits' }, rootNames: ['nessie'], serverName: 'coding-sessions',
      },
      label: 'Studio',
    })]
    const prepared = await world.prepare({ executorIds: [minis, studio], limits: { ticketUsd: 10 } })
    const preparing = await policyOf(prisma, prepared.policyId)
    assert.equal(preparing.status, 'preparing')
    assert.equal(preparing.triggerDigest, standingPolicyTermsDigest(preparing.pinnedTerms as never))
    assert.deepEqual(preparing.executors.map((row) => [row.executorId, row.position, row.descriptorConfigDigest]), [
      [minis, 0, `sha256:${'a'.repeat(64)}`], [studio, 1, `sha256:${'e'.repeat(64)}`],
    ])
    // Roots left out: the roots the machines share.
    assert.deepEqual((preparing.hostProfile as { allowedRootNames: string[] }).allowedRootNames, ['nessie'])

    // The card says it in plain words.
    const card = AgentCardSpecSchema.parse(prepared.card)
    const text = JSON.stringify(card)
    assert.equal(card.title, 'Let CTO use Minis and Studio')
    assert.ok(text.includes('Anyone who can edit this board (3 people) can make Claude run commands on these '
      + 'machines as you, with your git and coding-agent login.'))
    assert.match(text, /Project members, organisation owners and people on the ticket see what the work does/)
    assert.match(text, /merged under your GitHub identity/)
    assert.match(text, /"label":"Starts work in","value":"In progress"/)
    assert.match(text, /"label":"Board","value":"Engineering"/)
    assert.match(text, /Claude Code, at most \$5 a turn on Minis and \$4 a turn on Studio/)
    assert.match(text, /\*\*Studio:\*\* This machine cannot merge; tickets will stop at an open pull request\./)
    assert.doesNotMatch(text, /\*\*Minis:\*\* This machine cannot merge/)
    assert.match(text, /At most 4 hours, \$10 and 30 wakes/)
    assert.match(text, /At most 20 tickets started and \$60 spent/)
    // The instructions, word for word, escaped so they render as written.
    const fold = card.blocks.find((block) => block.type === 'details')
    const literal = fold?.type === 'details'
      ? fold.blocks.map((block) => (block.type === 'text' ? block.markdown : '')).join('\n').replace(/\\(.)/g, '$1')
      : ''
    assert.match(literal, /Read the ticket, then have Claude open a pull request and merge it on green\./)
    assert.match(literal, /Comment that you picked it up\./)
    assert.equal(card.actions[0]?.key, 'review')

    const result = await world.confirm(prepared)
    assert.equal(result.executorId, minis)
    const live = await policyOf(prisma, prepared.policyId)
    assert.equal(live.status, 'live')
    assert.ok(live.confirmedAt)
    assert.deepEqual(live.authorOrigin, {
      organizationId: world.organizationId, teamId: world.teamId, userId: world.authorId,
    })
    for (const executorId of [minis, studio]) {
      const assignment = await prisma.executorPrivateAssignment.findFirst({
        where: { agentId: world.agentId, executorId, principalKind: 'agent' },
      })
      assert.equal(assignment?.role, 'use', 'the agent is on the machine\'s roster')
      const grants = await prisma.executorAgentOperationGrant.findMany({
        where: { agentId: world.agentId, executorId, state: 'allowed' },
        select: { operationKey: true },
      })
      assert.deepEqual(grants.map((grant) => grant.operationKey).sort(), ['mcp.call', 'mcp.tools'])
    }
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: world.agentId }, select: { toolPolicy: true } })
    const logical = await prisma.toolRegistryEntry.findMany({
      where: { organizationId: world.organizationId, toolId: { in: ['executor.mcp.tools', 'executor.mcp.call'] } },
      select: { id: true },
    })
    assert.equal(logical.length, 2)
    for (const entry of logical) {
      assert.equal((agent.toolPolicy as Record<string, unknown>)[entry.id], true, 'the executor tools are enabled')
    }
    assert.deepEqual(await auditActions(prisma, prepared.policyId), ['executor.policy.prepared', 'executor.policy.confirmed'])
    const confirmedRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'executor.policy.confirmed', resourceId: prepared.policyId },
    })
    const metadata = confirmedRow.metadata as { pool: unknown[]; triggerDigest: string; limits: { ticketUsd: number } }
    assert.equal(metadata.pool.length, 2)
    assert.equal(metadata.triggerDigest, live.triggerDigest)
    assert.equal(metadata.limits.ticketUsd, 10)
  })
})

dbTest('a failure part-way through the confirmation writes none of it', async () => {
  await withWorld(async (world, prisma) => {
    const [minis, studio] = [await world.machine(), await world.machine()]
    const prepared = await world.prepare({ executorIds: [minis, studio] })
    // The tool policy is the last effect per machine: an agent the author can
    // no longer see fails there, after the first machine's assignment and
    // grant were written.
    await prisma.agent.update({ where: { id: world.agentId }, data: { ownerUserId: world.colleagueId, visibility: 'private' } })
    await assert.rejects(world.confirm(prepared), /not an editable tool-policy target/)
    assert.equal(await prisma.executorPrivateAssignment.count({ where: { agentId: world.agentId } }), 0)
    assert.equal(await prisma.executorAgentOperationGrant.count({ where: { agentId: world.agentId } }), 0)
    assert.equal((await policyOf(prisma, prepared.policyId)).status, 'preparing')
    const continuation = await prisma.executorContinuation.findUniqueOrThrow({ where: { id: prepared.accessChangeId } })
    assert.equal(continuation.status, 'pending', 'the claim rolled back with the rest')
    await prisma.agent.update({ where: { id: world.agentId }, data: { ownerUserId: world.authorId, visibility: 'team' } })
    await world.confirm(prepared)
    assert.equal((await policyOf(prisma, prepared.policyId)).status, 'live')
  })
})

dbTest('a confirmation that goes without its service, or without fresh verification, confirms nothing', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const prepared = await world.prepare({ executorIds: [minis] })
    await assert.rejects(confirmExecutorAccessChange(prisma, world.authorContext, {
      accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
      freshVerificationSatisfied: true,
    }), (error: unknown) => error instanceof ExecutorError && error.code === 'EXECUTOR_ACCESS_CHANGE_STALE')
    await assert.rejects(confirmExecutorAccessChange(prisma, world.authorContext, {
      accessChangeId: prepared.accessChangeId, confirmationToken: prepared.confirmationToken,
      freshVerificationSatisfied: false,
    }, (tx, change) => applyExecutorAccessChangeEffects(tx, {
      actorContext: world.authorContext, change: change.change, executorId: change.executorId,
      ledgerSigningConfigured: false,
    })), (error: unknown) => error instanceof ExecutorError && error.code === 'EXECUTOR_FRESH_VERIFICATION_REQUIRED')
    // The generic door never prepares one: only the trigger's does, after checking it.
    await assert.rejects(
      prepareExecutorAccessChange(prisma, world.authorContext, { change: { kind: 'standing_policy' } as never, executorId: minis }),
      /Prepare machine access from its trigger/,
    )
    assert.equal((await policyOf(prisma, prepared.policyId)).status, 'preparing')
  })
})

dbTest('a trigger changed after the card was prepared refuses the confirmation', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const prepared = await world.prepare({ executorIds: [minis] })
    await updateAgentTrigger(prisma, { organizationId: world.organizationId, triggerId: world.triggerId }, {
      config: { instructions: { general: 'Something else entirely.' } },
    })
    await assert.rejects(world.confirm(prepared), /The trigger changed after this was prepared/)
    assert.equal((await policyOf(prisma, prepared.policyId)).status, 'preparing')
  })
})

dbTest('every pinned field\'s change suspends machine access, a lowered limit does not, and re-confirming requeues', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const scope = { organizationId: world.organizationId, triggerId: world.triggerId }
    const actor = { actor: { userId: world.colleagueId } }
    const platform = await prisma.board.create({
      data: { name: 'Platform', organizationId: world.organizationId, position: 1, projectId: world.projectId },
    })
    await prisma.boardColumn.create({
      data: { boardId: platform.id, category: 'in_progress', name: 'In progress', organizationId: world.organizationId, position: 0 },
    })
    // A lowered limit keeps it live, with its terms and digest moved down.
    let policyId = await confirmed(world, [minis])
    const lowered = await updateAgentTrigger(prisma, scope, { config: { limits: { wakesPerTicket: 10 } } }, actor)
    assert.deepEqual(lowered?.machineAccess, { kind: 'limits_lowered' })
    let policy = await policyOf(prisma, policyId)
    assert.equal(policy.status, 'live')
    assert.equal((policy.pinnedTerms as { limits: { wakesPerTicket: number } }).limits.wakesPerTicket, 10)
    assert.equal(policy.triggerDigest, standingPolicyTermsDigest(policy.pinnedTerms as never))

    const edits: Array<[string, Record<string, unknown>]> = [
      ['the general instructions', { config: { instructions: { general: 'Merge without review.' } } }],
      ['the instructions for a pickup', { config: { instructions: { onPickup: 'Say nothing.' } } }],
      ['the start-work columns', { config: { pickup: { columns: [{ name: 'In progress' }, { name: 'Review' }] } } }],
      ['assigning the ticket on pickup', { config: { pickup: { assignOnPickup: false, columns: [{ name: 'In progress' }] } } }],
      ['what wakes the agent', { config: { follow: { kinds: ['comment'] } } }],
      ['connected-board events', { config: { follow: { includeSourceEvents: true } } }],
      ['the columns that end work', { config: { endOn: [{ category: 'done' }] } }],
      ['the channel', { targetChannelId: world.opsId }],
      ['the board', { config: { boardId: platform.id, pickup: { columns: [{ name: 'In progress' }] } } }],
      ['the wakes a ticket', { config: { limits: { wakesPerTicket: 11 } } }],
      ['the tickets a day', { config: { limits: { startsPerDay: 50 } } }],
    ]
    for (const [field, edit] of edits) {
      const taskId = await world.task(`While ${field} changes`)
      const sessionId = randomUUID()
      const record = await world.work({ executorId: minis, policyId, sessionIds: [sessionId], status: 'active', taskId })
      // A colleague who can edit the board saves it: whoever saves suspends it.
      const updated = await updateAgentTrigger(prisma, scope, edit, actor)
      assert.equal(updated?.machineAccess?.kind, 'suspended', field)
      assert.ok(updated?.machineAccess?.kind === 'suspended' && updated.machineAccess.fields.includes(field),
        `${field}: ${JSON.stringify(updated?.machineAccess)}`)
      assert.equal(updated?.machineAccess?.kind === 'suspended' && updated.machineAccess.authorName, 'Ondrej')
      // What agent_trigger_update tells whoever saved it.
      assert.match(standingPolicyTriggerEditSentence(updated!.machineAccess!),
        /^Saving paused Ondrej's machine access for this trigger until they confirm it again \(changed: /)
      policy = await policyOf(prisma, policyId)
      assert.deepEqual([policy.status, policy.suspendedReason], ['suspended', 'trigger_changed'], field)
      const waiting = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: record.id } })
      assert.deepEqual([waiting.status, waiting.stateReason, waiting.executorId],
        ['waiting_machine', 'machine_access_suspended', null], field)
      const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({
        where: { executorId: minis, sessionId },
      })
      assert.equal(close.reason, 'policy_suspended')
      assert.equal(close.ownerKey, executorCodingSessionOwnerKey(minis, {
        actorUserId: world.authorId,
        agentId: world.agentId,
        contextId: ticketWorkCodingSessionContext(policyId, taskId),
      }), 'the ticket\'s own sessions, and nothing else of the author\'s')
      // A fresh card says what changed, and re-confirming queues the ticket under the new policy.
      const fresh = await world.prepare({ executorIds: [minis] })
      assert.match(JSON.stringify(fresh.card), new RegExp(`Changed since you last confirmed:[^"]*${field}`))
      await world.confirm(fresh)
      assert.equal((await policyOf(prisma, policyId)).endedReason, 'replaced')
      const queued = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: record.id } })
      // Queued with its reason and place, and the dispatcher enqueued; the machine is online and free.
      assert.deepEqual([queued.status, queued.stateReason, queued.policyId, queued.queuePosition],
        ['queued', 'queued_no_free_machine', fresh.policyId, 1], field)
      await prisma.agentTicketWork.update({
        where: { id: record.id }, data: { endedAt: new Date(), endedReason: 'left_flow', status: 'cancelled' },
      })
      policyId = fresh.policyId
    }
    const firstPolicy = await prisma.executorStandingPolicy.findFirstOrThrow({
      where: { triggerId: world.triggerId }, orderBy: { createdAt: 'asc' }, select: { id: true },
    })
    assert.deepEqual(await auditActions(prisma, firstPolicy.id), [
      'executor.policy.prepared', 'executor.policy.confirmed', 'executor.policy.limits_lowered',
      'executor.policy.suspended', 'executor.policy.ended',
    ])
    // An edit that pins nothing new leaves the live policy alone.
    const renamed = await updateAgentTrigger(prisma, scope, { name: 'Renamed' }, actor)
    assert.equal(renamed?.machineAccess, undefined)
    assert.equal((await policyOf(prisma, policyId)).status, 'live')
  })
})

dbTest('a descriptor review that changes a pool machine\'s digest suspends machine access', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const policyId = await confirmed(world, [minis])
    await world.proposeRevision(minis, 2, `sha256:${'f'.repeat(64)}`)
    const review = await prepareExecutorAccessChange(prisma, world.authorContext, {
      change: { kind: 'descriptor_review', revision: 2, status: 'active' }, executorId: minis,
    })
    await world.confirm(review)
    const policy = await policyOf(prisma, policyId)
    assert.deepEqual([policy.status, policy.suspendedReason], ['suspended', 'descriptor_changed'])
    const suspended = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'executor.policy.suspended', resourceId: policyId },
    })
    assert.deepEqual(suspended.metadata, {
      executorId: minis, paused: 0, reason: 'descriptor_changed', revision: 2, reviewStatus: 'active',
      triggerId: world.triggerId,
    })
  })
})

dbTest('disabling the trigger ends machine access and its work; deleting one ends it too', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const policyId = await confirmed(world, [minis])
    const taskId = await world.task('In flight')
    const sessionId = randomUUID()
    const record = await world.work({ executorId: minis, policyId, sessionIds: [sessionId], status: 'active', taskId })
    await updateAgentTrigger(prisma, { organizationId: world.organizationId, triggerId: world.triggerId }, {
      enabled: false,
    }, { actor: { userId: world.ownerId } })
    const policy = await policyOf(prisma, policyId)
    assert.deepEqual([policy.status, policy.endedReason, policy.endedByUserId], ['ended', 'trigger_disabled', world.ownerId])
    const ended = await prisma.agentTicketWork.findUniqueOrThrow({ where: { id: record.id } })
    assert.deepEqual([ended.status, ended.endedReason], ['cancelled', 'trigger_disabled'])
    const close = await prisma.executorCodingSessionCloseRequest.findFirstOrThrow({ where: { sessionId } })
    assert.equal(close.reason, 'trigger_changed')
    const endedRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'executor.policy.ended', resourceId: policyId },
    })
    assert.equal((endedRow.metadata as { reason: string }).reason, 'trigger_disabled')
    assert.equal(endedRow.actorId, world.ownerId)

    // Switched back on, it holds nothing until its author confirms again; then deleting it ends that.
    await updateAgentTrigger(prisma, { organizationId: world.organizationId, triggerId: world.triggerId }, {
      enabled: true,
    })
    const again = await confirmed(world, [minis])
    assert.equal(await deleteAgentTrigger(prisma, { organizationId: world.organizationId, triggerId: world.triggerId },
      { actor: { userId: world.authorId } }), true)
    const deleted = await policyOf(prisma, again)
    assert.deepEqual([deleted.status, deleted.endedReason, deleted.triggerId], ['ended', 'trigger_deleted', null])
  })
})

dbTest('a new prepare replaces the card still out, and a rejected card ends its policy', async () => {
  await withWorld(async (world, prisma) => {
    const minis = await world.machine()
    const first = await world.prepare({ executorIds: [minis] })
    const second = await world.prepare({ executorIds: [minis] })
    const replaced = await policyOf(prisma, first.policyId)
    assert.deepEqual([replaced.status, replaced.endedReason], ['ended', 'replaced'])
    assert.equal((await prisma.executorContinuation.findUniqueOrThrow({ where: { id: first.accessChangeId } })).status,
      'expired')
    await assert.rejects(world.confirm(first), /no longer pending/)
    await rejectExecutorAccessChange(prisma, world.authorContext, {
      accessChangeId: second.accessChangeId, confirmationToken: second.confirmationToken,
    }, (tx, rejected) => applyRejectedExecutorAccessChangeEffects(tx, {
      actorContext: world.authorContext, change: rejected.change,
    }))
    const rejected = await policyOf(prisma, second.policyId)
    assert.deepEqual([rejected.status, rejected.endedReason, rejected.endedByUserId], ['ended', 'person', world.authorId])
    assert.deepEqual(await auditActions(prisma, second.policyId), ['executor.policy.prepared', 'executor.policy.ended'])
  })
})
