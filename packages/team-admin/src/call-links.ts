import { randomBytes as nodeRandomBytes } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import {
  createGoogleMeetSpace,
  GOOGLE_MEET_CREATE_SCOPE,
  GoogleMeetApiError,
} from '@nessie/comms-google'
import { z } from 'zod'

import {
  CommsCredentialCoordinatorError,
  loadUserGoogleCommsCredential,
  markCommsConnectionNeedsReauthorization,
} from './comms-credential-coordinator.js'

export const CallLinkProviderSchema = z.enum([
  'google_meet',
  'jitsi',
  'microsoft_teams',
])
export type CallLinkProvider = z.infer<typeof CallLinkProviderSchema>

export type CallLinkErrorCode =
  | 'GOOGLE_NOT_CONNECTED'
  | 'GOOGLE_ACCOUNT_AMBIGUOUS'
  | 'MEET_SCOPE_MISSING'
  | 'GOOGLE_REAUTH_REQUIRED'
  | 'MEET_LINK_FAILED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'TEAM_NOT_FOUND'

export class CallLinkError extends Error {
  readonly code: CallLinkErrorCode

  constructor(code: CallLinkErrorCode, provider?: CallLinkProvider) {
    super(
      provider
        ? `[call-link] provider ${provider} is not configured`
        : `[call-link] ${code.toLowerCase().replaceAll('_', ' ')}`,
    )
    this.name = 'CallLinkError'
    this.code = code
  }
}

type CallLinkEnvironment = Record<string, string | undefined>

export const isCallLinkProviderConfigured = (
  provider: CallLinkProvider,
  env: CallLinkEnvironment = process.env,
): boolean => {
  if (provider === 'jitsi') return true
  if (provider === 'microsoft_teams') return false
  return Boolean(
    env['NESSIE_COMMS_GOOGLE_CLIENT_ID']
    && env['NESSIE_COMMS_GOOGLE_CLIENT_SECRET'],
  )
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

const encodeBase32 = (bytes: Uint8Array): string => {
  let bits = 0
  let value = 0
  let encoded = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  }
  return encoded
}

const jitsiOrigin = (env: CallLinkEnvironment): string => {
  const domain = env['NESSIE_JITSI_DOMAIN']?.trim() || 'meet.jit.si'
  const parsed = new URL(`https://${domain}`)
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new CallLinkError('PROVIDER_NOT_CONFIGURED', 'jitsi')
  }
  return parsed.origin
}

export type CreateCallLinkInput = {
  /**
   * The caller's OWN tenant, never derived from `teamId`.
   *
   * `Team` carries no `organizationId` — its tenancy runs through its project —
   * so this function used to read `team.project.organizationId` from the
   * caller-supplied team id and then use that as the tenant, including as the
   * organisation it loaded the user's Google credential under. The route's
   * tenant and the operation's tenant were different values, and no caller
   * *could* constrain it, because there was no parameter for it. Required, and
   * refused on mismatch, the way `loadChannelTeamProject` already does it.
   */
  organizationId: string
  /**
   * How this caller earned the right to mint a link for this team. Stated, not
   * inherited — the same reason `createProjectForUser` keeps its owner gate out
   * of the function.
   *
   * - `team_member`: the caller NAMED the team (the request body, a tool
   *   argument), so being in it is the whole entitlement, and `TeamMember` is
   *   checked here. Organisation membership is not enough:
   *   `docs/standards/team-model.md` makes the team the unit people are members
   *   of, and treating "in the org" as sufficient erases that level.
   * - `channel_member`: the caller named a CHANNEL and the team was derived
   *   from it. `startCallForUser` has already required membership of that
   *   channel, which is the narrower fact — a public channel's members are not
   *   necessarily in its team, so re-checking `TeamMember` here would refuse
   *   calls the call route allows.
   */
  entitlement: 'team_member' | 'channel_member'
  teamId: string
  userId: string
  provider?: CallLinkProvider
}

export type CreateCallLinkResult = {
  provider: CallLinkProvider
  meetingUri: string
}

export type CreateCallLinkDependencies = {
  encryptionSecret?: string
  env?: CallLinkEnvironment
  randomBytes?: (size: number) => Uint8Array
  loadGoogleCredential?: typeof loadUserGoogleCommsCredential
  createGoogleMeeting?: typeof createGoogleMeetSpace
}

const mapCredentialError = (error: CommsCredentialCoordinatorError): CallLinkError => {
  if (error.code === 'CONNECTION_NOT_FOUND') {
    return new CallLinkError('GOOGLE_NOT_CONNECTED')
  }
  if (error.code === 'SCOPE_MISSING' || error.code === 'CAPABILITY_BLOCKED') {
    return new CallLinkError('MEET_SCOPE_MISSING')
  }
  if (error.code === 'AMBIGUOUS_ACCOUNT') {
    return new CallLinkError('GOOGLE_ACCOUNT_AMBIGUOUS')
  }
  if (error.code === 'NEEDS_REAUTHORIZATION') {
    return new CallLinkError('GOOGLE_REAUTH_REQUIRED')
  }
  return new CallLinkError('GOOGLE_REAUTH_REQUIRED')
}

/**
 * Mint a provider link using the target team's configured default unless the
 * caller supplies the explicit override later used by the mirrored PA tool.
 */
export const createCallLinkForTeamUser = async (
  prisma: PrismaClient,
  input: CreateCallLinkInput,
  dependencies: CreateCallLinkDependencies = {},
): Promise<CreateCallLinkResult> => {
  const team = await prisma.team.findUnique({
    where: { id: input.teamId },
    select: {
      callProvider: true,
      project: { select: { organizationId: true } },
    },
  })
  // A team in another organisation is indistinguishable from one that does not
  // exist: the caller's tenant is the only tenant this operation may act in.
  if (!team || team.project.organizationId !== input.organizationId) {
    throw new CallLinkError('TEAM_NOT_FOUND')
  }

  const activeInOrganization = await prisma.organizationMember.findFirst({
    where: {
      organizationId: input.organizationId,
      userId: input.userId,
      deactivatedAt: null,
    },
    select: { id: true },
  })
  if (!activeInOrganization) throw new CallLinkError('TEAM_NOT_FOUND')

  if (input.entitlement === 'team_member') {
    const teamMembership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: input.teamId, userId: input.userId } },
      select: { id: true },
    })
    if (!teamMembership) throw new CallLinkError('TEAM_NOT_FOUND')
  }

  const parsedProvider = CallLinkProviderSchema.safeParse(
    input.provider ?? team.callProvider,
  )
  if (!parsedProvider.success) {
    throw new CallLinkError('PROVIDER_NOT_CONFIGURED')
  }
  const provider = parsedProvider.data
  const env = dependencies.env ?? process.env
  if (!isCallLinkProviderConfigured(provider, env)) {
    throw new CallLinkError('PROVIDER_NOT_CONFIGURED', provider)
  }

  if (provider === 'jitsi') {
    const random = (dependencies.randomBytes ?? nodeRandomBytes)(16)
    return {
      provider,
      meetingUri: `${jitsiOrigin(env)}/nessie-${encodeBase32(random)}`,
    }
  }
  if (provider === 'microsoft_teams') {
    throw new CallLinkError('PROVIDER_NOT_CONFIGURED', provider)
  }

  let credential
  try {
    const encryptionSecret = dependencies.encryptionSecret
      ?? env['NESSIE_AUTH_SECRET']
    if (!encryptionSecret) {
      throw new CallLinkError('MEET_LINK_FAILED')
    }
    credential = await (
      dependencies.loadGoogleCredential ?? loadUserGoogleCommsCredential
    )(prisma, {
      organizationId: input.organizationId,
      userId: input.userId,
      requiredScopes: [GOOGLE_MEET_CREATE_SCOPE],
      capabilityId: 'meet.create',
      encryptionSecret,
    })
  } catch (error) {
    if (error instanceof CommsCredentialCoordinatorError) {
      throw mapCredentialError(error)
    }
    throw error
  }

  try {
    const meetingUri = await (
      dependencies.createGoogleMeeting ?? createGoogleMeetSpace
    )(credential.credential.accessToken)
    return { provider, meetingUri }
  } catch (error) {
    if (error instanceof GoogleMeetApiError && error.status === 401) {
      await markCommsConnectionNeedsReauthorization(prisma, credential.id)
      throw new CallLinkError('GOOGLE_REAUTH_REQUIRED')
    }
    throw new CallLinkError('MEET_LINK_FAILED')
  }
}
