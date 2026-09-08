import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'

import {
  createUoaSubjectAssertion,
  loadUoaDelegatedIdentitySettings,
  type UoaDelegatedIdentitySettings,
} from './uoa-delegated-identity.js'
import {
  requestUoaOrganization,
  UoaOrgRequestRejectedError,
  UoaOrgRequestUnavailableError,
  type UoaOrgRequestDeps,
} from './uoa-org-request.js'

const NESSIE_PRODUCT_SLUG = 'nessie'

export type UoaLiveEntitlementsPrisma = Pick<PrismaClient,
  'organization' | 'organizationMember' | 'productAccountLink' | 'team'>

/** Stable local references derived from one fresh UOA `/org/me` response. */
export type LiveEntitlements =
  | { kind: 'local'; organizationId: string; userId: string }
  | {
    kind: 'uoa'
    organizationId: string
    organizationRole: string
    teamIds: readonly string[]
    userId: string
  }
  | { kind: 'denied' }

/**
 * Request identity is required at an interactive boundary. The stored-link arm
 * is deliberately opt-in for delivery/grant rechecks that have no request
 * session; its subject and epoch still have to survive `/org/me`.
 */
export type ResolveLiveEntitlementsInput = {
  allowStoredIdentity?: boolean
  organizationId: string
  uoaIdentity?: UoaSessionIdentity
  userId: string
}

export type ResolveLiveEntitlementsDeps = UoaOrgRequestDeps & {
  settings?: UoaDelegatedIdentitySettings | null
  uoaConfigured?: boolean
}

/** Shared deployment-mode signal, independent of a complete signing key set. */
export const isUoaDeploymentConfigured = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => Boolean(env.UOA_DOMAIN?.trim() || env.UOA_CONFIG_URL?.trim())

type AssertionIdentity = {
  organizationId: string
  subject: string
  teamId: string
  tokenVersion: number
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim())
    ? [...new Set(value.map((item) => item.trim()))]
    : null

const identityFromRequest = async (
  prisma: UoaLiveEntitlementsPrisma,
  input: ResolveLiveEntitlementsInput,
  externalOrgId: string,
): Promise<AssertionIdentity | null> => {
  const identity = input.uoaIdentity
  if (
    !identity
    || identity.organizationId !== externalOrgId
    || identity.tokenVersion === null
  ) return null

  const link = await prisma.productAccountLink.findUnique({
    where: { organizationId_userId_productSlug: {
      organizationId: input.organizationId,
      productSlug: NESSIE_PRODUCT_SLUG,
      userId: input.userId,
    } },
    select: { status: true, uoaSub: true, uoaTokenVersion: true },
  })
  if (
    link?.status !== 'linked'
    || link.uoaSub !== identity.subject
    || link.uoaTokenVersion !== identity.tokenVersion
  ) return null
  return {
    organizationId: identity.organizationId,
    subject: identity.subject,
    teamId: identity.teamId,
    tokenVersion: identity.tokenVersion,
  }
}

const identityFromStoredLink = async (
  prisma: UoaLiveEntitlementsPrisma,
  input: ResolveLiveEntitlementsInput,
  externalOrgId: string,
): Promise<AssertionIdentity | null> => {
  if (!input.allowStoredIdentity || input.uoaIdentity) return null
  const link = await prisma.productAccountLink.findUnique({
    where: { organizationId_userId_productSlug: {
      organizationId: input.organizationId,
      productSlug: NESSIE_PRODUCT_SLUG,
      userId: input.userId,
    } },
    select: {
      activeOrgId: true,
      activeTeamId: true,
      status: true,
      uoaSub: true,
      uoaTokenVersion: true,
    },
  })
  if (
    link?.status !== 'linked'
    || link.activeOrgId !== externalOrgId
    || !link.activeTeamId
    || !link.uoaSub
    || link.uoaTokenVersion === null
  ) return null
  return {
    organizationId: link.activeOrgId,
    subject: link.uoaSub,
    teamId: link.activeTeamId,
    tokenVersion: link.uoaTokenVersion,
  }
}

const localTeamIds = async (
  prisma: UoaLiveEntitlementsPrisma,
  organizationId: string,
  externalOrgId: string,
  externalTeamIds: readonly string[],
): Promise<string[]> => {
  if (externalTeamIds.length === 0) return []
  const teams = await prisma.team.findMany({
    where: {
      externalOrgId,
      externalTeamId: { in: [...externalTeamIds] },
      project: { organizationId },
    },
    select: { id: true },
  })
  return teams.map((team) => team.id)
}

/**
 * Reads one live UOA membership response and translates it to existing Nessie
 * team ids. It intentionally neither writes nor caches UOA roster data.
 */
export const resolveLiveEntitlements = async (
  prisma: UoaLiveEntitlementsPrisma,
  input: ResolveLiveEntitlementsInput,
  deps: ResolveLiveEntitlementsDeps = {},
): Promise<LiveEntitlements> => {
  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { externalOrgId: true },
  })
  if (!organization) return { kind: 'denied' }
  if (!organization.externalOrgId) {
    const uoaConfigured = deps.uoaConfigured ?? isUoaDeploymentConfigured()
    if (uoaConfigured) return { kind: 'denied' }
    const membership = await prisma.organizationMember.findFirst({
      where: { deactivatedAt: null, organizationId: input.organizationId, userId: input.userId },
      select: { id: true },
    })
    return membership
      ? { kind: 'local', organizationId: input.organizationId, userId: input.userId }
      : { kind: 'denied' }
  }

  const identity = await identityFromRequest(prisma, input, organization.externalOrgId)
    ?? await identityFromStoredLink(prisma, input, organization.externalOrgId)
  const settings = deps.settings === undefined
    ? loadUoaDelegatedIdentitySettings()
    : deps.settings
  if (!identity || !settings) return { kind: 'denied' }

  try {
    const payload = await requestUoaOrganization(settings, '/org/me', { method: 'GET' }, {
      fetchImpl: deps.fetchImpl,
      resolveHost: deps.resolveHost,
      subjectAssertion: createUoaSubjectAssertion(settings, identity, `${settings.authBaseUrl}/org`),
    })
    const org = record(record(payload)?.org)
    const resolvedOrgId = text(org?.org_id)
    const organizationRole = text(org?.org_role)
    const externalTeamIds = stringList(org?.teams)
    if (
      resolvedOrgId !== organization.externalOrgId
      || !organizationRole
      || !externalTeamIds
    ) return { kind: 'denied' }
    return {
      kind: 'uoa',
      organizationId: input.organizationId,
      organizationRole,
      teamIds: await localTeamIds(
        prisma,
        input.organizationId,
        organization.externalOrgId,
        externalTeamIds,
      ),
      userId: input.userId,
    }
  } catch (error) {
    if (
      error instanceof UoaOrgRequestRejectedError
      || error instanceof UoaOrgRequestUnavailableError
    ) return { kind: 'denied' }
    throw error
  }
}
