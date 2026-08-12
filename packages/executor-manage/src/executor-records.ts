import { createHash, randomBytes } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import { ExecutorCapabilityDescriptorSchema, ExecutorScopeSchema } from '@nessie/schemas'
import type {
  AuthorizedActionContext,
  ExecutorScope,
} from '@nessie/schemas'

import {
  canManageExecutor,
  canViewExecutor,
  isOrganizationManager,
  requireHumanActor,
  resolveExecutorHumanAccess,
  type ExecutorHumanAccess,
} from './executor-access.js'
import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

const PAIRING_TTL_MS = 10 * 60 * 1_000

type ExecutorRow = {
  id: string
  organizationId: string
  projectId: string | null
  scopeKind: 'private' | 'project' | 'organization'
  pairingOwnerUserId: string
  label: string
  profiles: Array<'workspace_sandbox' | 'coding_session'>
  platformFacts: unknown
  machineKeyFingerprint: string | null
  status: 'pending_pairing' | 'online' | 'offline' | 'paused' | 'draining' | 'revoked' | 'error'
  authorizationRevision: number
  lastSeenAt: Date | null
  statusDetail: string | null
  createdAt: Date
  updatedAt: Date
}

export type ExecutorRecord = {
  id: string
  scope: ExecutorScope
  label: string
  profiles: Array<'workspace_sandbox' | 'coding_session'>
  platformFacts: Record<string, unknown>
  machineKeyFingerprint?: string
  status: ExecutorRow['status']
  authorizationRevision: number
  lastSeenAt?: string
  statusDetail?: string
  createdAt: string
  updatedAt: string
}

export type ExecutorPairingInvitation = {
  enrollmentId: string
  challenge: string
  expiresAt: string
}

export type ExecutorAccessView = {
  canManage: boolean
  executorId: string
  effectiveAccess: {
    organizationRole: ExecutorHumanAccess['organizationRole']
    privateAssignment: ExecutorHumanAccess['privateAssignment']
    projectRole: ExecutorHumanAccess['projectRole']
  }
  descriptorRevisions?: Array<{
    localPolicyDigest: string
    operationKeys: string[]
    profiles: Array<'workspace_sandbox' | 'coding_session'>
    reviewStatus: 'pending_review' | 'active' | 'disabled'
    revision: number
  }>
  operationGrants?: Array<{
    agentId: string
    operationKey: string
    state: 'allowed' | 'denied'
    updatedAt: string
  }>
  privateAssignments?: Array<
    | { principalKind: 'user'; role: 'use' | 'admin'; userId: string }
    | { agentId: string; principalKind: 'agent'; role: 'use' }
  >
  sessions?: Array<{
    createdAt: string
    id: string
    profile: 'workspace_sandbox' | 'coding_session'
    runId?: string
    status: 'pending' | 'active' | 'attention' | 'detached' | 'stopped' | 'failed'
    updatedAt: string
  }>
}

export type CreateExecutorInput = {
  label: string
  scope:
    | { kind: 'private'; organizationId: string }
    | { kind: 'project'; organizationId: string; projectId: string }
    | { kind: 'organization'; organizationId: string }
  privateAssignments?: Array<
    | { principalKind: 'user'; userId: string; role: 'use' | 'admin' }
    | { principalKind: 'agent'; agentId: string; role: 'use' }
  >
}

const recordFromRow = (row: ExecutorRow): ExecutorRecord => ({
  id: row.id,
  scope: ExecutorScopeSchema.parse(row.scopeKind === 'project'
    ? { kind: 'project', organizationId: row.organizationId, projectId: row.projectId! }
    : { kind: row.scopeKind, organizationId: row.organizationId }),
  label: row.label,
  profiles: row.profiles,
  platformFacts: row.platformFacts && typeof row.platformFacts === 'object'
    && !Array.isArray(row.platformFacts)
    ? row.platformFacts as Record<string, unknown>
    : {},
  ...(row.machineKeyFingerprint ? { machineKeyFingerprint: row.machineKeyFingerprint } : {}),
  status: row.status,
  authorizationRevision: row.authorizationRevision,
  ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt.toISOString() } : {}),
  ...(row.statusDetail ? { statusDetail: row.statusDetail } : {}),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

const challengeVerifier = (challenge: string): string =>
  `sha256:${createHash('sha256').update(challenge).digest('hex')}`

const assertAssignmentShape = (
  actorUserId: string,
  assignments: NonNullable<CreateExecutorInput['privateAssignments']>,
): void => {
  const users = new Set<string>()
  const agents = new Set<string>()
  let actorIsAdmin = false
  for (const assignment of assignments) {
    if (assignment.principalKind === 'user') {
      if (users.has(assignment.userId)) {
        throw new ExecutorError(
          EXECUTOR_ERROR_CODES.SCOPE_INVALID,
          'A user may appear only once in a private executor roster.',
        )
      }
      users.add(assignment.userId)
      actorIsAdmin ||= assignment.userId === actorUserId && assignment.role === 'admin'
    } else {
      if (agents.has(assignment.agentId)) {
        throw new ExecutorError(
          EXECUTOR_ERROR_CODES.SCOPE_INVALID,
          'An agent may appear only once in a private executor roster.',
        )
      }
      agents.add(assignment.agentId)
    }
  }
  if (!actorIsAdmin) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'The pairing user must be an initial private executor administrator.',
    )
  }
}

const assertCreateScopeEntitlement = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateExecutorInput,
): Promise<string> => {
  const actorUserId = requireHumanActor(actorContext)
  if (!actorUserId || input.scope.organizationId !== actorContext.tenant.organizationId) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'A human organization member must create an executor in the active organization.',
    )
  }
  const membership = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: {
        organizationId: input.scope.organizationId,
        userId: actorUserId,
      },
    },
    select: { deactivatedAt: true, role: true },
  })
  if (!membership || membership.deactivatedAt) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'The pairing user is not an active organization member.',
    )
  }
  if (input.scope.kind === 'private') {
    assertAssignmentShape(actorUserId, input.privateAssignments ?? [])
    return actorUserId
  }
  if (input.scope.kind === 'organization') {
    if (!isOrganizationManager(membership.role)) {
      throw new ExecutorError(
        EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
        'Organization executors require organization owner or admin access.',
      )
    }
    return actorUserId
  }

  const [project, projectMembership] = await Promise.all([
    prisma.project.findFirst({
      where: { id: input.scope.projectId, organizationId: input.scope.organizationId },
      select: { id: true },
    }),
    prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: input.scope.projectId, userId: actorUserId },
      },
      select: { role: true },
    }),
  ])
  if (
    !project
    || !(
      isOrganizationManager(membership.role)
      || projectMembership?.role === 'owner'
      || projectMembership?.role === 'admin'
    )
  ) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.SCOPE_ENTITLEMENT_DENIED,
      'Project executors require project owner or admin access.',
    )
  }
  return actorUserId
}

export const createExecutor = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  input: CreateExecutorInput,
  now = new Date(),
): Promise<{ executor: ExecutorRecord; invitation: ExecutorPairingInvitation }> => {
  const actorUserId = await assertCreateScopeEntitlement(prisma, actorContext, input)
  const challenge = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS)

  return prisma.$transaction(async (tx) => {
    const executor = await tx.executor.create({
      data: {
        organizationId: input.scope.organizationId,
        projectId: input.scope.kind === 'project' ? input.scope.projectId : null,
        scopeKind: input.scope.kind,
        pairingOwnerUserId: actorUserId,
        label: input.label,
      },
    })
    if (input.scope.kind === 'private') {
      await tx.executorPrivateAssignment.createMany({
        data: (input.privateAssignments ?? []).map((assignment) => (
          assignment.principalKind === 'user'
            ? {
                executorId: executor.id,
                principalKind: 'user',
                userId: assignment.userId,
                role: assignment.role,
              }
            : {
                executorId: executor.id,
                principalKind: 'agent',
                agentId: assignment.agentId,
                role: 'use',
              }
        )),
      })
    }
    const enrollment = await tx.executorEnrollment.create({
      data: {
        executorId: executor.id,
        challengeVerifier: challengeVerifier(challenge),
        expiresAt,
      },
    })
    return {
      executor: recordFromRow(executor),
      invitation: {
        enrollmentId: enrollment.id,
        challenge,
        expiresAt: expiresAt.toISOString(),
      },
    }
  })
}

export const listVisibleExecutors = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
): Promise<ExecutorRecord[]> => {
  const userId = requireHumanActor(actorContext)
  if (!userId) return []
  const organizationId = actorContext.tenant.organizationId
  const [membership, projectMemberships] = await Promise.all([
    prisma.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { deactivatedAt: true, role: true },
    }),
    prisma.projectMember.findMany({
      where: { userId, project: { organizationId } },
      select: { projectId: true },
    }),
  ])
  if (!membership || membership.deactivatedAt) return []
  const visibleSharedScope = isOrganizationManager(membership.role)
  const projectIds = projectMemberships.map((entry) => entry.projectId)
  const rows = await prisma.executor.findMany({
    where: {
      organizationId,
      OR: [
        { scopeKind: 'organization' },
        ...(visibleSharedScope ? [{ scopeKind: 'project' as const }] : []),
        ...(projectIds.length > 0 ? [{ scopeKind: 'project' as const, projectId: { in: projectIds } }] : []),
        {
          scopeKind: 'private',
          privateAssignments: {
            some: { principalKind: 'user', userId },
          },
        },
      ],
    },
    orderBy: [{ createdAt: 'desc' }],
  })
  return rows.map(recordFromRow)
}

export const getExecutorForUser = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<{ executor: ExecutorRecord; access: ExecutorHumanAccess } | null> => {
  const userId = requireHumanActor(actorContext)
  if (!userId) return null
  const executor = await prisma.executor.findFirst({
    where: { id: executorId, organizationId: actorContext.tenant.organizationId },
  })
  if (!executor) return null
  const access = await resolveExecutorHumanAccess(
    prisma,
    actorContext.tenant.organizationId,
    userId,
    executor,
  )
  if (!canViewExecutor(executor, access)) return null
  return { executor: recordFromRow(executor), access }
}

export const getExecutorForManagement = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<{ executor: ExecutorRecord; access: ExecutorHumanAccess } | null> => {
  const found = await getExecutorForUser(prisma, actorContext, executorId)
  return found && canManageExecutor(
    {
      id: found.executor.id,
      projectId: found.executor.scope.kind === 'project' ? found.executor.scope.projectId : null,
      scopeKind: found.executor.scope.kind,
    },
    found.access,
  )
    ? found
    : null
}

export const getExecutorAccessView = async (
  prisma: PrismaClient,
  actorContext: AuthorizedActionContext,
  executorId: string,
): Promise<ExecutorAccessView | null> => {
  const found = await getExecutorForUser(prisma, actorContext, executorId)
  if (!found) return null
  const canManage = canManageExecutor(
    {
      id: found.executor.id,
      projectId: found.executor.scope.kind === 'project'
        ? found.executor.scope.projectId
        : null,
      scopeKind: found.executor.scope.kind,
    },
    found.access,
  )
  if (!canManage) {
    return {
      canManage: false,
      executorId: found.executor.id,
      effectiveAccess: found.access,
    }
  }
  const [privateAssignments, operationGrants, descriptorRevisions, sessions] = await Promise.all([
    found.executor.scope.kind === 'private'
      ? prisma.executorPrivateAssignment.findMany({
          where: { executorId: found.executor.id },
          orderBy: [{ principalKind: 'asc' }, { createdAt: 'asc' }],
          select: { agentId: true, principalKind: true, role: true, userId: true },
        })
      : [],
    prisma.executorAgentOperationGrant.findMany({
      where: { executorId: found.executor.id },
      orderBy: [{ agentId: 'asc' }, { operationKey: 'asc' }],
      select: { agentId: true, operationKey: true, state: true, updatedAt: true },
    }),
    prisma.executorCapabilityRevision.findMany({
      where: { executorId: found.executor.id },
      orderBy: { revision: 'desc' },
      take: 20,
      select: { descriptor: true, localPolicyDigest: true, reviewStatus: true, revision: true },
    }),
    prisma.executorSession.findMany({
      where: { executorId: found.executor.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { createdAt: true, id: true, profile: true, runId: true, status: true, updatedAt: true },
    }),
  ])
  return {
    canManage: true,
    executorId: found.executor.id,
    effectiveAccess: found.access,
    ...(found.executor.scope.kind === 'private'
      ? {
          privateAssignments: privateAssignments.map((assignment) => (
            assignment.principalKind === 'user'
              ? {
                  principalKind: 'user' as const,
                  role: assignment.role as 'use' | 'admin',
                  userId: assignment.userId!,
                }
              : {
                  agentId: assignment.agentId!,
                  principalKind: 'agent' as const,
                  role: 'use' as const,
                }
          )),
        }
      : {}),
    descriptorRevisions: descriptorRevisions.flatMap((revision) => {
      const descriptor = ExecutorCapabilityDescriptorSchema.safeParse(revision.descriptor)
      return descriptor.success
        ? [{
            localPolicyDigest: revision.localPolicyDigest,
            operationKeys: descriptor.data.operationKeys,
            profiles: descriptor.data.profiles,
            reviewStatus: revision.reviewStatus,
            revision: revision.revision,
          }]
        : []
    }),
    operationGrants: operationGrants.map((grant) => ({
      agentId: grant.agentId,
      operationKey: grant.operationKey,
      state: grant.state,
      updatedAt: grant.updatedAt.toISOString(),
    })),
    sessions: sessions.map((session) => ({
      createdAt: session.createdAt.toISOString(),
      id: session.id,
      profile: session.profile,
      ...(session.runId ? { runId: session.runId } : {}),
      status: session.status,
      updatedAt: session.updatedAt.toISOString(),
    })),
  }
}
