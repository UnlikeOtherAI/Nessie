import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import {
  EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME,
  executorCodingSessionOwnerKeyInput,
  ExecutorCodingSessionsFactsSchema,
} from '@nessie/schemas'

import { EXECUTOR_ERROR_CODES, ExecutorError } from './executor-errors.js'

/**
 * Who may drive the executor's built-in coding-sessions bridge
 * (docs/executor-protocol/host-coding-sessions.md). A coding agent it runs
 * acts with the host OS user's full authority — their files, their git and
 * SSH credentials, their Claude or ChatGPT login — so an `mcp.call` to it is
 * allowed only on a **private** executor and only for a binding made for that
 * executor's **pairing owner**. Anyone else entitled to a shared executor
 * would otherwise drive its owner's subscription and disk.
 *
 * The rule is checked where every command is created and again where the
 * daemon collects it, from the binding's own provenance: the consumed
 * availability candidate names the person, never anything the model sent.
 * The same check pins the payload's `owner` — the worker stamps it for the
 * bridge from that candidate, and no other server ever gets one.
 */

/** Who an `mcp.call` to the bridge acts for: `ExecutorMcpCallOwnerSchema`, unbranded. */
export type ExecutorCodingSessionOwner = { actorUserId: string; agentId: string }

/**
 * The key the bridge isolates an owner's sessions by: `sha256:` + hex SHA-256
 * of the owner-key text, exactly as the daemon derives `_meta['nessie/owner']`,
 * so a close request names the owner the daemon stamped.
 */
export const executorCodingSessionOwnerKey = (executorId: string, owner: ExecutorCodingSessionOwner): string =>
  `sha256:${createHash('sha256').update(executorCodingSessionOwnerKeyInput(executorId, owner)).digest('hex')}`

type ExecutorOwnership = {
  pairingOwnerUserId: string
  scopeKind: 'private' | 'project' | 'organization'
}

type OwnerClient = Pick<PrismaClient, 'executorAvailabilityCandidate' | 'executorBinding'> | Prisma.TransactionClient

export const executorCodingSessionsAllowed = (executor: ExecutorOwnership, actorUserId: string): boolean =>
  executor.scopeKind === 'private' && executor.pairingOwnerUserId === actorUserId

/** The reviewed bridge's server name, when the bound revision offers it. */
export const reviewedCodingSessionsServer = (descriptor: unknown): string | null => {
  const facts = ExecutorCodingSessionsFactsSchema.safeParse(
    (descriptor as { codingSessions?: unknown } | null | undefined)?.codingSessions,
  )
  return facts.success ? facts.data.serverName : null
}

const ownerOnlyRefusal = (executor: ExecutorOwnership): ExecutorError => new ExecutorError(
  EXECUTOR_ERROR_CODES.CODING_SESSIONS_OWNER_ONLY,
  executor.scopeKind === 'private'
    ? 'Coding sessions on this machine act as the person who paired it — with their files, their git and SSH '
      + 'credentials and their coding-agent login — so only that person can drive them, and this run was started '
      + 'by someone else.'
    : 'Coding sessions act as the machine’s owner — with their files, their git and SSH credentials and their '
      + 'coding-agent login — so they run only on a private executor, driven by the person who paired it. This '
      + 'executor is shared, so no run can drive its coding sessions.',
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const sameOwner = (stamped: unknown, expected: ExecutorCodingSessionOwner | undefined): boolean => {
  if (expected === undefined) return stamped === undefined
  return isRecord(stamped)
    && Object.keys(stamped).length === 2
    && stamped.agentId === expected.agentId
    && stamped.actorUserId === expected.actorUserId
}

export type ExecutorMcpCallAuthority = {
  codingSessionsServer: string | null
  executor: ExecutorOwnership
  operationKey: string
  /** The binding's consumed candidate: the agent and the person it was made for. */
  owner: ExecutorCodingSessionOwner
}

/**
 * Refuses an `mcp.call` to the bridge the rule does not allow — whatever the
 * revision says, the reserved name is always the bridge's — and any payload
 * whose `owner` is not exactly the binding's: present for the reviewed
 * bridge, absent for every other server.
 */
export const assertExecutorMcpCallAllowed = (
  authority: ExecutorMcpCallAuthority,
  payload: Record<string, unknown>,
): void => {
  if (authority.operationKey !== 'mcp.call') return
  const server = isRecord(payload.args) && typeof payload.args.server === 'string' ? payload.args.server : null
  const bridge = server !== null
    && (server === EXECUTOR_CODING_SESSIONS_MCP_SERVER_NAME || server === authority.codingSessionsServer)
  if (bridge && !executorCodingSessionsAllowed(authority.executor, authority.owner.actorUserId)) {
    throw ownerOnlyRefusal(authority.executor)
  }
  const expected = server !== null && server === authority.codingSessionsServer ? authority.owner : undefined
  if (!sameOwner(payload.owner, expected)) {
    throw new ExecutorError(
      EXECUTOR_ERROR_CODES.COMMAND_PAYLOAD_INVALID,
      expected
        ? 'A call to the coding-sessions bridge must carry the owner its binding was made for.'
        : 'Only a call to the coding-sessions bridge carries an owner.',
    )
  }
}

/** The same check, reading its facts from the binding and its consumed candidate. */
export const assertExecutorMcpCallPayload = async (
  prisma: OwnerClient,
  bindingId: string,
  payload: Record<string, unknown>,
): Promise<void> => {
  const binding = await prisma.executorBinding.findUnique({
    where: { id: bindingId },
    select: {
      candidateHandleDigest: true,
      capabilityRevision: { select: { descriptor: true } },
      executor: { select: { pairingOwnerUserId: true, scopeKind: true } },
      operationKey: true,
    },
  })
  if (binding?.operationKey !== 'mcp.call') return
  const candidate = await prisma.executorAvailabilityCandidate.findUnique({
    where: { handleDigest: binding.candidateHandleDigest },
    select: { actorUserId: true, agentId: true },
  })
  if (!candidate) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.BINDING_FENCED, 'Executor binding provenance is no longer available.')
  }
  assertExecutorMcpCallAllowed({
    codingSessionsServer: reviewedCodingSessionsServer(binding.capabilityRevision.descriptor),
    executor: binding.executor,
    operationKey: binding.operationKey,
    owner: { actorUserId: candidate.actorUserId, agentId: candidate.agentId },
  }, payload)
}
