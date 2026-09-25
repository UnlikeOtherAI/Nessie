import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext, ExecutorSsoVerification } from '@nessie/schemas'
import { ExecutorVerificationChallengeSchema } from '@nessie/schemas'
import { executorAccessVerificationBinding, ExecutorError, EXECUTOR_ERROR_CODES } from '@nessie/executor-manage'
import {
  createUoaSubjectAssertion, loadUoaDelegatedIdentitySettings, requestUoaOrganization,
} from '@nessie/runtime'
import { z } from 'zod'

export const executorSsoVerificationAvailable = (actor: AuthorizedActionContext): boolean =>
  actor.actor.actorType === 'user' && !actor.actionContext.agentCredentialId
  && actor.actionContext.uoaIdentity?.tokenVersion != null && loadUoaDelegatedIdentitySettings() !== null

export const executorSsoVerification = async (
  prisma: PrismaClient, actor: AuthorizedActionContext,
  input: { accessChangeId: string; confirmationToken: string; verification?: ExecutorSsoVerification },
) => {
  const identity = actor.actionContext.uoaIdentity
  const settings = loadUoaDelegatedIdentitySettings()
  if (!executorSsoVerificationAvailable(actor) || !identity || identity.tokenVersion === null || !settings) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.FRESH_VERIFICATION_REQUIRED, 'Sign in again to verify this change.')
  }
  const link = await prisma.productAccountLink.findUnique({ where: { organizationId_userId_productSlug: {
    organizationId: actor.tenant.organizationId, userId: actor.actor.actorId, productSlug: 'nessie',
  } } })
  if (link?.status !== 'linked' || link.uoaSub !== identity.subject
    || link.uoaTokenVersion !== identity.tokenVersion || link.activeOrgId !== identity.organizationId) {
    throw new ExecutorError(EXECUTOR_ERROR_CODES.FRESH_VERIFICATION_REQUIRED, 'Sign in again to verify this change.')
  }
  const binding = await executorAccessVerificationBinding(prisma, actor, input)
  const machine = await prisma.executor.findUnique({ where: { id: binding.executorId }, select: { label: true } })
  const verification = input.verification
  const result = await requestUoaOrganization(settings,
    `/auth/action-verification/${verification ? 'verify' : 'start'}`, {
      method: 'POST', body: {
        actionDigest: binding.actionDigest,
        ...(verification ?? { description: `Approve machine access changes for ${machine?.label ?? 'your machine'}` }),
      },
    }, {
      subjectAssertion: createUoaSubjectAssertion(settings, {
        organizationId: identity.organizationId, subject: identity.subject,
        teamId: identity.teamId, tokenVersion: identity.tokenVersion,
      }, `${settings.authBaseUrl}/org`),
    })
  if (!verification) return ExecutorVerificationChallengeSchema.parse(result)
  const proof = z.object({ verified: z.literal(true), actionDigest: z.literal(binding.actionDigest) }).parse(result)
  return proof
}
