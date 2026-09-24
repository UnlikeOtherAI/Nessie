import type { Prisma, PrismaClient } from '@prisma/client'
import {
  ExecutorCapabilityDescriptorSchema,
  type ExecutorCodingSessionsFacts,
  type StandingPolicyHostMachine,
  type StandingPolicyMachineRefusal,
} from '@nessie/schemas'

import { canManageExecutor, resolveExecutorHumanAccess } from './executor-access.js'
import { EXECUTOR_LOCAL_APPS_OPERATION_KEYS } from './executor-conversation-lease.js'
import { executorHeartbeatCutoff } from './executor-liveness.js'

/**
 * Whether one machine can take a trigger's ticket work under a standing
 * policy, and what the policy pins about it
 * (docs/plans/2026-09-23-ticket-driven-agents/machine-access.md → "The host
 * profile", "Prepare and confirm").
 *
 * The coding-sessions rule, unchanged: a **private** machine whose **pairing
 * owner** is the policy's author, which the author still administers (the
 * confirmation assigns the agent and grants it the suite), whose live
 * reviewed revision offers the local-apps pair and the coding bridge. Then the
 * unattended host profile: Claude Code with a signed per-turn budget no larger
 * than what a ticket may spend (Codex has none, so it never works a ticket),
 * not in `bypassPermissions` unless the author ticked the option, and every
 * coding root the author allowed. Prepare also wants it online; a confirm a
 * few minutes later does not, since being offline for a moment changes
 * nothing the author agreed to.
 */

type Client = PrismaClient | Prisma.TransactionClient

export type StandingPolicyMachineCheck = {
  allowAnyCommand: boolean
  /** Null: whatever roots the pool shares, decided by the caller once every machine is read. */
  allowedRootNames: readonly string[] | null
  authorUserId: string
  executorId: string
  organizationId: string
  requireOnline: boolean
  ticketUsd: number
}

export type StandingPolicyMachineAssessment =
  | {
      ok: true
      authorizationRevision: number
      descriptorConfigDigest: string
      executorId: string
      facts: ExecutorCodingSessionsFacts
      host: StandingPolicyHostMachine
      label: string
      localPolicyDigest: string
    }
  | { ok: false; executorId: string; label: string | null; reason: StandingPolicyMachineRefusal; sentence: string }

const dollars = (amount: number): string => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`

/** The live policy exactly as enforcement defines it: the latest revision, only while it is active. */
const liveRevision = async (client: Client, executorId: string) => {
  const latest = await client.executorCapabilityRevision.findFirst({
    where: { executorId },
    orderBy: { revision: 'desc' },
    select: { descriptor: true, localPolicyDigest: true, reviewStatus: true },
  })
  if (!latest || latest.reviewStatus !== 'active') return null
  const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(latest.descriptor)
  if (!descriptor.success) return null
  return { descriptor: descriptor.data, localPolicyDigest: latest.localPolicyDigest }
}

/**
 * The digests a policy pins for one machine, read from its live revision now:
 * the coding bridge's reviewed configuration and the whole local policy. Null
 * when the machine offers no reviewed bridge at all.
 */
export const standingPolicyMachineDigests = async (
  client: Client,
  executorId: string,
): Promise<{ descriptorConfigDigest: string; localPolicyDigest: string } | null> => {
  const live = await liveRevision(client, executorId)
  const facts = live?.descriptor.codingSessions
  return live && facts
    ? { descriptorConfigDigest: facts.configDigest, localPolicyDigest: live.localPolicyDigest }
    : null
}

/**
 * One pool machine's digests as the dequeue reads them (T5): from its latest
 * revision while that is active — null digests when it offers no reviewed
 * bridge — or `unreviewed` while that revision awaits review or was disabled.
 * The review door settles an unreviewed revision itself, suspending the
 * policies whose pinned digests it moves, so until then the dequeue places no
 * work on the machine and suspends nothing.
 */
export const standingPolicyMachineRevision = async (
  client: Client,
  executorId: string,
): Promise<{ kind: 'active'; digests: { descriptorConfigDigest: string; localPolicyDigest: string } | null }
  | { kind: 'unreviewed' }> => {
  const latest = await client.executorCapabilityRevision.findFirst({
    where: { executorId },
    orderBy: { revision: 'desc' },
    select: { descriptor: true, localPolicyDigest: true, reviewStatus: true },
  })
  if (!latest || latest.reviewStatus !== 'active') return { kind: 'unreviewed' }
  const facts = ExecutorCapabilityDescriptorSchema.safeParse(latest.descriptor).data?.codingSessions
  return {
    kind: 'active',
    digests: facts ? { descriptorConfigDigest: facts.configDigest, localPolicyDigest: latest.localPolicyDigest } : null,
  }
}

/** Whether a descriptor offers what ticket work needs: both local-apps keys and the reviewed bridge. */
export const offersReviewedCodingSessions = (descriptor: {
  codingSessions?: ExecutorCodingSessionsFacts
  operationKeys: readonly string[]
}): boolean => descriptor.codingSessions !== undefined
  && EXECUTOR_LOCAL_APPS_OPERATION_KEYS.every((key) => descriptor.operationKeys.includes(key))

export const assessStandingPolicyMachine = async (
  client: Client,
  input: StandingPolicyMachineCheck,
  now = new Date(),
): Promise<StandingPolicyMachineAssessment> => {
  const executor = await client.executor.findFirst({
    where: { id: input.executorId, organizationId: input.organizationId, removedAt: null },
    select: {
      authorizationRevision: true, id: true, label: true, lastSeenAt: true, pairingOwnerUserId: true,
      projectId: true, scopeKind: true, status: true,
    },
  })
  const refuse = (reason: StandingPolicyMachineRefusal, sentence: string): StandingPolicyMachineAssessment => ({
    executorId: input.executorId, label: executor?.label ?? null, ok: false, reason, sentence,
  })
  if (!executor) return refuse('not_found', 'No machine with that id is paired in this organisation.')
  const name = executor.label
  if (executor.scopeKind !== 'private') {
    return refuse('not_private', `${name} is shared with ${executor.scopeKind === 'project' ? 'its project' : 'the '
      + 'whole organisation'}, and coding sessions run only on a private machine, as the person who paired it.`)
  }
  if (executor.pairingOwnerUserId !== input.authorUserId) {
    return refuse('paired_by_someone_else', `${name} was paired by someone else. Its coding sessions act as them, `
      + 'so only they can offer it.')
  }
  const access = await resolveExecutorHumanAccess(client, input.organizationId, input.authorUserId, executor)
  if (!canManageExecutor(executor, access)) {
    return refuse('not_administrator', `You no longer administer ${name}, so you cannot give an agent access to it.`)
  }
  const live = await liveRevision(client, executor.id)
  const facts = live?.descriptor.codingSessions
  if (!live || !facts || !offersReviewedCodingSessions(live.descriptor)) {
    return refuse('no_reviewed_coding_sessions', `${name} has no reviewed coding-sessions bridge. Offer Claude Code `
      + 'in its coding-sessions configuration and approve the new revision on its page.')
  }
  if (input.requireOnline && (executor.status !== 'online' || !executor.lastSeenAt
    || executor.lastSeenAt < executorHeartbeatCutoff(now))) {
    return refuse('offline', `${name} is ${executor.status === 'paused' ? 'paused' : 'offline'}. Bring it online first.`)
  }
  if (facts.maxBudgetUsd === undefined || facts.maxLiveSessionsPerOwner === undefined) {
    return refuse('older_executor', `${name}'s executor is too old to state its per-turn budget and session limit. `
      + 'Update it and approve the new revision.')
  }
  const budget = facts.agents.includes('claude') ? facts.maxBudgetUsd.claude : undefined
  if (budget === undefined) {
    return refuse('no_turn_budget', `${name} offers only Codex, which has no per-turn spending limit, so it cannot `
      + 'work tickets unattended.')
  }
  if (budget === null) {
    return refuse('no_turn_budget', `Claude Code on ${name} has no per-turn spending limit. Set maxBudgetUsd in its `
      + 'coding-sessions configuration.')
  }
  if (budget > input.ticketUsd) {
    return refuse('turn_budget_above_ticket', `Claude Code on ${name} may spend ${dollars(budget)} a turn, more than `
      + `the ${dollars(input.ticketUsd)} a ticket may spend. Lower its maxBudgetUsd or raise ticketUsd.`)
  }
  const permissionMode = facts.permissionMode.claude ?? 'default'
  if (permissionMode === 'bypassPermissions' && !input.allowAnyCommand) {
    return refuse('bypass_not_allowed', `Claude Code on ${name} runs in bypassPermissions, so it would run any `
      + 'command without asking. That needs "Let the coding agent run any command without asking." ticked.')
  }
  const missing = (input.allowedRootNames ?? []).filter((root) => !facts.rootNames.includes(root))
  if (missing.length > 0) {
    return refuse('root_missing', `${name} has no coding root named ${missing.join(' or ')} (it has `
      + `${facts.rootNames.join(', ')}).`)
  }
  return {
    authorizationRevision: executor.authorizationRevision,
    descriptorConfigDigest: facts.configDigest,
    executorId: executor.id,
    facts,
    host: {
      executorId: executor.id,
      label: name,
      maxBudgetUsd: budget,
      maxLiveSessionsPerOwner: facts.maxLiveSessionsPerOwner,
      mergeCommands: facts.mergeCommands ?? [],
      permissionMode,
    },
    label: name,
    localPolicyDigest: live.localPolicyDigest,
    ok: true,
  }
}
