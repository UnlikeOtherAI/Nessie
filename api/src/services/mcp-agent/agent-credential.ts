import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AgentAccessCredential, AgentAccessScope, PrismaClient } from '@prisma/client'
import {
  AuthorizedActionContextSchema,
  UoaSessionIdentitySchema,
  type AuthorizedActionContext,
  type UoaSessionIdentity,
} from '@nessie/schemas'

/**
 * The credential an agent presents to the MCP endpoint.
 *
 * Deliberately the same shape as `VoiceDeviceCredential`: an opaque,
 * prefix-recognised token, hashed at rest, carrying its granting human's tenant
 * scope and token generation, refused outside its own routes. That is this
 * codebase's answer to "a non-browser client needs a scoped, revocable
 * credential", and a second shape would be a second thing to reason about.
 *
 * What it is NOT is an identity. It names a human, and every tool call runs as
 * that human against the same service functions the HTTP routes call — so an
 * agent can never reach anything its granting human could not reach by
 * clicking. The scopes narrow that reach; they never widen it.
 */

/**
 * `nag1_` — Nessie AGent, v1. Distinct from the voice prefix (`nvc1_`) so the
 * global hook can tell which verifier owns a bearer without trying each in
 * turn, and so a credential presented to the wrong surface fails with an error
 * that names the actual problem.
 */
export const AGENT_CREDENTIAL_PREFIX = 'nag1_'

const TOKEN_BYTES = 32

/** 90 days. Long enough to be useful to a long-running agent, short enough
 * that an abandoned one stops working without anybody remembering to revoke it. */
export const AGENT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60_000

export const hashAgentCredential = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

export const isAgentCredentialToken = (token: string): boolean =>
  token.startsWith(AGENT_CREDENTIAL_PREFIX)

const generateAgentCredentialToken = (): string =>
  `${AGENT_CREDENTIAL_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`

export type MintedAgentCredential = {
  credential: AgentAccessCredential
  /** The only moment this value exists outside the agent that receives it. */
  token: string
}

export const mintAgentAccessCredential = async (
  prisma: PrismaClient,
  input: {
    label: string
    organizationId: string
    projectId: string
    scopes: AgentAccessScope[]
    teamId: string | null
    ttlMs?: number
    /** The approving human's UOA workspace, when their session carried one. */
    uoaIdentity?: unknown
    userId: string
  },
): Promise<MintedAgentCredential> => {
  const user = await prisma.user.findUnique({
    select: { tokenVersion: true },
    where: { id: input.userId },
  })
  if (!user) {
    throw new Error('Cannot mint an agent credential for a user that does not exist')
  }

  const token = generateAgentCredentialToken()
  const credential = await prisma.agentAccessCredential.create({
    data: {
      expiresAt: new Date(Date.now() + (input.ttlMs ?? AGENT_CREDENTIAL_TTL_MS)),
      label: input.label,
      organizationId: input.organizationId,
      projectId: input.projectId,
      scopes: input.scopes,
      teamId: input.teamId,
      tokenHash: hashAgentCredential(token),
      // Enough to tell two credentials apart in a list without holding either
      // secret; never enough to reconstruct one.
      tokenPrefix: token.slice(0, AGENT_CREDENTIAL_PREFIX.length + 6),
      tokenVersion: user.tokenVersion,
      ...(input.uoaIdentity === undefined || input.uoaIdentity === null
        ? {}
        : { uoaIdentity: input.uoaIdentity as never }),
      userId: input.userId,
    },
  })

  return { credential, token }
}

/**
 * The stored UOA workspace, if it still matches the contract.
 *
 * Returns undefined rather than throwing: a credential whose captured identity
 * has gone malformed should still read boards, and the paths that genuinely
 * need the identity fail closed on their own.
 */
const replayableUoaIdentity = (
  stored: unknown,
): UoaSessionIdentity | undefined => {
  if (stored === null || stored === undefined) return undefined
  const parsed = UoaSessionIdentitySchema.safeParse(stored)
  return parsed.success ? parsed.data : undefined
}

export type AgentCredentialRejection =
  | 'AGENT_CREDENTIAL_INVALID'
  | 'AGENT_CREDENTIAL_EXPIRED'
  | 'AGENT_CREDENTIAL_REVOKED'

export type AgentCredentialVerification =
  | {
      actorContext: AuthorizedActionContext
      credential: AgentAccessCredential
      ok: true
      scopes: AgentAccessScope[]
    }
  | { code: AgentCredentialRejection; message: string; ok: false }

/**
 * Verify a presented credential and resolve who it acts as.
 *
 * Every liveness fact is re-read here rather than trusted from the token,
 * because revoking a credential, deactivating the member, and forcing a
 * sign-out all have to take effect on the next call rather than at expiry.
 */
export const verifyAgentAccessCredential = async (
  prisma: PrismaClient,
  token: string,
): Promise<AgentCredentialVerification> => {
  const presented = hashAgentCredential(token)
  const credential = await prisma.agentAccessCredential.findUnique({
    where: { tokenHash: presented },
  })
  if (!credential) {
    return {
      code: 'AGENT_CREDENTIAL_INVALID',
      message: 'Invalid agent credential',
      ok: false,
    }
  }
  // The lookup was by digest so this is equal by construction; it is here so
  // the comparison stays constant-time if that lookup ever becomes a scan.
  if (
    !timingSafeEqual(Buffer.from(credential.tokenHash, 'hex'), Buffer.from(presented, 'hex'))
  ) {
    return {
      code: 'AGENT_CREDENTIAL_INVALID',
      message: 'Invalid agent credential',
      ok: false,
    }
  }

  if (credential.revokedAt) {
    return {
      code: 'AGENT_CREDENTIAL_REVOKED',
      message: 'Agent credential revoked',
      ok: false,
    }
  }
  if (credential.expiresAt.getTime() <= Date.now()) {
    return {
      code: 'AGENT_CREDENTIAL_EXPIRED',
      message: 'Agent credential expired',
      ok: false,
    }
  }

  const [user, membership] = await Promise.all([
    prisma.user.findUnique({
      select: { tokenVersion: true },
      where: { id: credential.userId },
    }),
    prisma.organizationMember.findUnique({
      select: { deactivatedAt: true, role: true },
      where: {
        organizationId_userId: {
          organizationId: credential.organizationId,
          userId: credential.userId,
        },
      },
    }),
  ])

  // A forced sign-out or password change bumps the user generation, and a
  // credential minted before it is as dead as that person's access tokens.
  // Without this, "sign me out everywhere" would quietly mean "everywhere
  // except the agents I lent my account to".
  if (!user || user.tokenVersion !== credential.tokenVersion) {
    return {
      code: 'AGENT_CREDENTIAL_REVOKED',
      message: 'Agent credential revoked',
      ok: false,
    }
  }
  if (!membership || membership.deactivatedAt) {
    return {
      code: 'AGENT_CREDENTIAL_REVOKED',
      message: 'Agent credential revoked',
      ok: false,
    }
  }

  return {
    // Parsed, never cast. This context reaches the same authorization and
    // attribution code an ordinary session's does, and a hand-built literal
    // that merely satisfies TypeScript is how a required field goes missing
    // without anything failing.
    actorContext: AuthorizedActionContextSchema.parse({
      actionContext: {
        effectiveUserId: credential.userId,
        requestId: randomUUID(),
        // Replayed so background work this call starts — an embedding job for a
        // document the agent just wrote — can sign as the person who approved
        // the pairing. Re-verified downstream against the live account link
        // exactly as a session's is, so this is replay, not a second source of
        // truth. Parsed rather than cast: a stored shape that no longer matches
        // is dropped instead of reaching the signer.
        ...(replayableUoaIdentity(credential.uoaIdentity)
          ? { uoaIdentity: replayableUoaIdentity(credential.uoaIdentity) }
          : {}),
      },
      actor: {
        actorId: credential.userId,
        actorType: 'user',
        // Live membership, never anything the credential carries, so a
        // demotion takes effect on the next call.
        roles: [membership.role],
      },
      tenant: {
        organizationId: credential.organizationId,
        projectId: credential.projectId,
        // Omitted rather than null when the granting session had no team: the
        // tenant contract treats an absent team as "not scoped to one", and a
        // null is a different claim the schema rightly refuses.
        ...(credential.teamId ? { teamId: credential.teamId } : {}),
      },
    }),
    credential,
    ok: true,
    scopes: credential.scopes,
  }
}

/** Records use, so an operator can see which agents are actually live. */
export const touchAgentAccessCredential = async (
  prisma: PrismaClient,
  credentialId: string,
): Promise<void> => {
  await prisma.agentAccessCredential.updateMany({
    data: { lastUsedAt: new Date() },
    where: { id: credentialId, revokedAt: null },
  })
}

export const revokeAgentAccessCredential = async (
  prisma: PrismaClient,
  input: { credentialId: string; organizationId: string },
): Promise<boolean> => {
  const revoked = await prisma.agentAccessCredential.updateMany({
    data: { revokedAt: new Date() },
    where: {
      id: input.credentialId,
      organizationId: input.organizationId,
      revokedAt: null,
    },
  })
  return revoked.count > 0
}
