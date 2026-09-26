import { Prisma } from '@prisma/client'
import { ExecutorCapabilityDescriptorSchema } from '@nessie/schemas'
import type { ExecutorCodingSessionOwner } from './executor-coding-session-owner.js'
import { isExecutorLeaseLive } from './executor-conversation-lease.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'
import { expireStaleExecutorHeartbeats } from './executor-liveness.js'
import { resolveExecutorAvailability } from './availability.js'
import { ensureExecutorLogicalTools } from './executor-logical-tools.js'
import { resolveExecutorSharedAccess } from './executor-shared-access.js'
import { resolveExecutorScopeFacts } from './executor-scope-facts.js'
import { assertStandingPolicyBindingCurrent, isStandingBinding } from './executor-standing-policy-fence.js'
import { resolveChatReminderMachines } from './executor-chat-reminder-binding.js'

const CODING_SESSION_OPERATION_KEYS = new Set([
  'coding.launch',
  'coding.observe',
  'workspace.review',
  'sandbox.stop',
])
const COMMAND_SESSION_OPERATION_KEYS = new Set([
  'command.run',
  'workspace.review',
  'sandbox.stop',
])

const booleanRecord = (value: unknown): Record<string, boolean> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === 'boolean',
        ),
      )
    : {}

/**
 * What a current binding is: its executor, run and session, and whom it was
 * made for — the consumed candidate's agent and person, which the worker
 * stamps as the `owner` of a call to the coding-sessions bridge, with the work
 * context when the binding pins one.
 */
export type ExecutorCommandBindingFacts = {
  executorId: string
  owner: ExecutorCodingSessionOwner
  runId: string
  sessionId: string | null
}

/** New work is fenced immediately when policy, revision, or lifecycle changes. */
export const assertExecutorCommandBindingCurrent = async (
  tx: Prisma.TransactionClient,
  bindingId: string,
  options: {
    allowPendingBrowserOpen?: boolean
    allowPendingCodingLaunch?: boolean
    allowPendingCommandRun?: boolean
    now?: Date
  } = {},
): Promise<ExecutorCommandBindingFacts> => {
  let binding = await tx.executorBinding.findUnique({
    where: { id: bindingId },
    select: {
      authorizationRevision: true,
      candidateHandleDigest: true,
      capabilityRevisionId: true,
      executorId: true,
      operationKey: true,
      runId: true,
      sessionId: true,
      session: { select: { executorId: true, profile: true, runId: true, status: true } },
    },
  })
  if (!binding) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.NOT_FOUND, 'Executor binding is unavailable.')
  }
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${`executor:${binding.executorId}`}, 0))
  `)
  // The first lookup yields only the executor identity used for the advisory
  // lock. Re-read after that lock so a concurrent sandbox.stop cannot change
  // this browser session between an earlier snapshot and delivery.
  const lockedBinding = await tx.executorBinding.findUnique({
    where: { id: bindingId },
    select: {
      authorizationRevision: true,
      candidateHandleDigest: true,
      capabilityRevisionId: true,
      executorId: true,
      leaseId: true,
      operationKey: true,
      runId: true,
      sessionId: true,
      session: { select: { executorId: true, profile: true, runId: true, status: true } },
      standingPolicyId: true,
      ticketWorkId: true,
    },
  })
  if (!lockedBinding || lockedBinding.executorId !== binding.executorId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding changed while command delivery was being fenced.',
    )
  }
  binding = lockedBinding
  // A binding made under a conversation lease lives only as long as the lease:
  // ended by a person or a fencing transition, or past either window, it is
  // fenced like a revoked grant. Read under the executor lock every lease
  // transition takes.
  if (lockedBinding.leaseId) {
    const lease = await tx.executorConversationLease.findUnique({
      where: { id: lockedBinding.leaseId },
      select: { absoluteExpiresAt: true, endedAt: true, executorId: true, idleExpiresAt: true },
    })
    if (!lease || lease.executorId !== binding.executorId || !isExecutorLeaseLive(lease, options.now ?? new Date())) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.BINDING_FENCED,
        'The conversation lease for this executor binding has ended.',
      )
    }
  }
  await expireStaleExecutorHeartbeats(
    tx,
    { executorId: binding.executorId },
    options.now ?? new Date(),
  )
  const candidate = await tx.executorAvailabilityCandidate.findUnique({
    where: { handleDigest: binding.candidateHandleDigest },
    select: {
      actorUserId: true,
      agentId: true,
      authorizationRevision: true,
      executorId: true,
      runId: true,
    },
  })
  if (
    !candidate
    || candidate.executorId !== binding.executorId
    || candidate.authorizationRevision !== binding.authorizationRevision
    || (candidate.runId !== null && candidate.runId !== binding.runId)
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding provenance is no longer available.',
    )
  }
  const commandSession = binding.session?.profile === 'workspace_sandbox'
  const sessionMatchesBinding = Boolean(
    binding.sessionId
    && binding.session?.executorId === binding.executorId
    && binding.session?.runId === binding.runId,
  )
  const commandBoundOperation = (
    binding.operationKey === 'command.run'
    || (commandSession && COMMAND_SESSION_OPERATION_KEYS.has(binding.operationKey))
  )
  if (
    commandBoundOperation && binding.operationKey !== 'sandbox.stop'
    && (
      !sessionMatchesBinding
      || !commandSession
      || (
        binding.session?.status !== 'active'
        && !(
          options.allowPendingCommandRun === true
          && binding.operationKey === 'command.run'
          && binding.session?.status === 'pending'
        )
      )
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'The command session is no longer active for this executor command.',
    )
  }
  const executor = await tx.executor.findUnique({
    where: { id: binding.executorId },
    select: {
      authorizationRevision: true,
      id: true,
      organizationId: true,
      projectId: true,
      scopeKind: true,
      status: true,
      capabilityRevisions: { orderBy: { revision: 'desc' }, select: { id: true }, take: 1 },
      operationGrants: {
        where: { agentId: candidate.agentId, operationKey: binding.operationKey },
        select: { state: true },
      },
      privateAssignments: {
        select: { agentId: true, principalKind: true, role: true, userId: true },
      },
    },
  })
  if (!executor) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding is no longer authorized for new work.',
    )
  }
  const [capabilityRevision, run, membership, agent, logicalTools] = await Promise.all([
    tx.executorCapabilityRevision.findUnique({
      where: { id: binding.capabilityRevisionId },
      select: { descriptor: true, reviewStatus: true },
    }),
    tx.run.findUnique({
      where: { id: binding.runId },
      select: {
        agentId: true,
        triggerMessage: { select: { userId: true } },
        thread: { select: { channel: { select: { organizationId: true, projectId: true } } } },
      },
    }),
    tx.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: executor.organizationId,
          userId: candidate.actorUserId,
        },
      },
      select: { deactivatedAt: true },
    }),
    tx.agent.findFirst({
      where: { id: candidate.agentId, organizationId: executor.organizationId },
      select: { toolPolicy: true },
    }),
    ensureExecutorLogicalTools(tx, executor.organizationId),
  ])
  const projectId = run?.thread.channel.projectId ?? null
  const projectMembership = projectId
    ? await tx.projectMember.findFirst({
        where: {
          projectId,
          project: { organizationId: executor.organizationId },
          userId: candidate.actorUserId,
        },
        select: { id: true },
      })
    : null
  const descriptor = capabilityRevision
    ? ExecutorCapabilityDescriptorSchema.safeParse(capabilityRevision.descriptor)
    : null
  const decision = resolveExecutorAvailability({
    descriptorApproved:
      capabilityRevision?.reviewStatus === 'active'
      && executor.capabilityRevisions[0]?.id === binding.capabilityRevisionId
      && descriptor?.success === true,
    executorStatus: executor.status,
    localPolicyAllows: Boolean(
      descriptor?.success && descriptor.data.operationKeys.includes(binding.operationKey as never),
    ),
    logicalToolAllowed: Boolean(
      agent && booleanRecord(agent.toolPolicy)[logicalTools.get(binding.operationKey as never) ?? ''] === true,
    ),
    operationGrantState: executor.operationGrants[0]?.state ?? null,
    scope: resolveExecutorScopeFacts(
      executor,
      candidate.actorUserId,
      candidate.agentId,
      { projectId, projectMember: Boolean(projectMembership),
        sharedUse: (await resolveExecutorSharedAccess(tx, executor.id, candidate.actorUserId, projectId)).use },
    ),
  })
  // A standing policy's binding answers to its policy and work record
  // (`executor-standing-policy-fence.ts`); a chat reminder to its creating run,
  // and every other binding to its trigger's author.
  const standing = isStandingBinding(lockedBinding)
    ? await assertStandingPolicyBindingCurrent(tx, lockedBinding, candidate)
    : null
  const reminder = !standing && !lockedBinding.leaseId && run?.triggerMessage?.userId === null
    && (binding.operationKey === 'mcp.tools' || binding.operationKey === 'mcp.call')
    ? await resolveChatReminderMachines(tx, binding.runId) : null
  const reminderAuthorized = reminder?.userId === candidate.actorUserId
    && reminder?.agentId === candidate.agentId && reminder?.executorIds.includes(binding.executorId)
  if (
    executor.authorizationRevision !== binding.authorizationRevision
    || !run
    || run.agentId !== candidate.agentId
    || (!standing && !reminderAuthorized && run.triggerMessage?.userId !== candidate.actorUserId)
    || run.thread.channel.organizationId !== executor.organizationId
    || !membership
    || membership.deactivatedAt !== null
    || !decision.available
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'Executor binding is no longer authorized for new work.',
    )
  }
  if (
    commandSession
    && binding.operationKey === 'command.run'
    && (!sessionMatchesBinding || !COMMAND_SESSION_OPERATION_KEYS.has(binding.operationKey))
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'A command session cannot dispatch an operation outside its exact bundle.',
    )
  }
  if (
    (
      binding.operationKey === 'browser.open'
      || binding.operationKey === 'browser.observe'
      || binding.operationKey === 'browser.act'
    )
    && (
      !sessionMatchesBinding
      || binding.session?.profile !== 'workspace_sandbox'
      || (
        binding.session.status !== 'active'
        && !(
          options.allowPendingBrowserOpen === true
          && binding.operationKey === 'browser.open'
          && binding.session.status === 'pending'
        )
      )
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'The browser session is no longer active for this executor command.',
    )
  }
  const codingSession = binding.session?.profile === 'coding_session'
  const codingBoundOperation = (
    binding.operationKey === 'coding.launch'
    || binding.operationKey === 'coding.observe'
    || (codingSession && CODING_SESSION_OPERATION_KEYS.has(binding.operationKey))
  )
  if (
    codingBoundOperation && binding.operationKey !== 'sandbox.stop'
    && (
      !sessionMatchesBinding
      || !codingSession
      || (
        binding.session?.status !== 'active'
        && binding.session?.status !== 'attention'
        && !(
          options.allowPendingCodingLaunch === true
          && binding.operationKey === 'coding.launch'
          && binding.session?.status === 'pending'
        )
      )
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'The coding session is no longer active for this executor command.',
    )
  }
  if (
    codingSession
    && (!sessionMatchesBinding || !CODING_SESSION_OPERATION_KEYS.has(binding.operationKey))
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.BINDING_FENCED,
      'A coding session cannot dispatch an operation outside its exact bundle.',
    )
  }
  return {
    executorId: executor.id,
    owner: {
      actorUserId: candidate.actorUserId,
      agentId: candidate.agentId,
      ...(standing ? { contextId: standing.contextId } : {}),
    },
    runId: binding.runId,
    sessionId: binding.sessionId,
  }
}

