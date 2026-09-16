import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ImapError,
  MailDialError,
  MailWireError,
  normalizeAddress,
  resolveMailboxEndpoints,
  SmtpError,
  testMailboxConnection,
  type MailboxLegResolution,
  type MailboxResolution,
  type MailSecurity,
} from '@nessie/agent-mail'
// The record and scope shapes are the wire contract, so they live in
// `@nessie/schemas` and are imported here rather than restated — the API
// response and this presenter are one type by construction.
import type {
  MailboxConnectionDiagnosis,
  MailboxConnectionRecord,
  MailboxConnectionScope,
  MailboxLegDiagnosis,
} from '@nessie/schemas'
import {
  AT_REST_SECRET_PURPOSE,
  sealSecret,
  toEncryptionKeyRing,
} from '@nessie/comms-connect'

import {
  mailboxDialOptions,
  mailboxEndpointsFor,
  type MailboxConnectionRow,
} from './mailbox-connection-endpoints.js'

/**
 * SMTP/IMAP mailbox connection lifecycle — agent email Model A.
 *
 * One implementation, called by the API routes, so nothing forks when a
 * personal-assistant tool later wants to connect a mailbox by conversation.
 *
 * Scope follows the established MCP install rules: a member connects their own
 * mailbox, an owner or admin connects a shared one for a team. The distinction
 * matters because the two are different promises — a personal mailbox is only
 * ever readable by runs acting as that person, while a team mailbox is a shared
 * resource whose reach is decided per agent.
 */

export type MailboxConnectionRefusal =
  | 'not_permitted'
  | 'team_not_found'
  | 'connection_not_found'
  | 'invalid_address'
  | 'address_taken'
  | 'credential_rejected'
  | 'invalid_certificate'
  | 'server_unavailable'
  | 'test_failed'
  | 'agent_not_found'

export class MailboxConnectionError extends Error {
  constructor(
    readonly refusal: MailboxConnectionRefusal,
    message: string,
    /**
     * Present when the refusal came from resolving endpoints. It is what lets
     * the form ask for the one setting that is still missing instead of
     * offering the whole advanced screen to somebody whose inbox already
     * worked.
     */
    readonly diagnosis?: MailboxConnectionDiagnosis,
  ) {
    super(message)
    this.name = 'MailboxConnectionError'
  }
}

type ConnectionWithAccess = MailboxConnectionRow & {
  agentAccess?: { agentId: string }[]
}

export type MailboxConnectionTestFailure = Extract<
  MailboxConnectionRefusal,
  'credential_rejected' | 'invalid_certificate' | 'server_unavailable' | 'test_failed'
>

const NETWORK_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
])

/**
 * Protocol layers carry structural failure classes. Keep them through the
 * connection boundary rather than deriving a diagnosis from an error message.
 */
export const mailboxConnectionTestFailure = (
  error: unknown,
): MailboxConnectionTestFailure => {
  if (
    (error instanceof ImapError || error instanceof SmtpError)
    && error.kind === 'auth'
  ) return 'credential_rejected'
  if (error instanceof MailDialError && error.kind === 'certificate') {
    return 'invalid_certificate'
  }
  if (
    error instanceof MailDialError
    || error instanceof MailWireError
    || (typeof error === 'object' && error !== null
      && NETWORK_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? ''))
    || (error instanceof SmtpError && error.kind === 'transient')
  ) return 'server_unavailable'
  return 'test_failed'
}

const testFailureMessage = (failure: MailboxConnectionTestFailure): string => {
  switch (failure) {
    case 'credential_rejected':
      return 'The email address or password was not accepted.'
    case 'invalid_certificate':
      return 'We cannot connect securely to this mail server.'
    case 'server_unavailable':
      return 'The mail server is temporarily unavailable.'
    default:
      return 'The mailbox connection test could not be completed.'
  }
}

/**
 * The presenter. It cannot emit the credential — the password lives in a
 * separate table that no read here joins — and it is the only shape that
 * reaches a browser.
 */
export const presentMailboxConnection = (
  connection: ConnectionWithAccess,
): MailboxConnectionRecord => ({
  address: connection.address,
  agentIds: (connection.agentAccess ?? []).map((row) => row.agentId),
  createdByUserId: connection.createdByUserId,
  id: connection.id,
  imapHost: connection.imapHost,
  imapPort: connection.imapPort,
  imapSecurity: connection.imapSecurity,
  label: connection.label,
  lastVerifiedAt: connection.lastVerifiedAt?.toISOString() ?? null,
  ownerUserId: connection.ownerUserId,
  scope: connection.ownerUserId ? 'user' : 'team',
  smtpHost: connection.smtpHost,
  smtpPort: connection.smtpPort,
  smtpSecurity: connection.smtpSecurity,
  status: connection.status,
  statusReason: connection.statusReason,
  teamId: connection.teamId,
  username: connection.username,
})

/**
 * One leg's outcome, in the shape a browser receives. The endpoint it names is
 * either a hostname the person typed or one derived from their own address
 * domain — the resolver has no other source — so naming it tells them which
 * server we mean without disclosing anything they did not already supply.
 */
const legDiagnosis = (leg: MailboxLegResolution): MailboxLegDiagnosis => {
  if (leg.ok) {
    return { host: leg.endpoint.host, ok: true, port: leg.endpoint.port }
  }
  const last = leg.tried.at(-1)
  return {
    failure: leg.failure,
    ok: false,
    ...(last ? { host: last.host, port: last.port } : {}),
  }
}

const INCOMING = 'incoming mail (IMAP) server'
const OUTGOING = 'outgoing mail (SMTP) server'

/**
 * What to say when endpoints could not be resolved.
 *
 * Deliberately per leg. "Could not connect this mailbox" is true of every
 * failure and therefore useless: a person whose inbox was reached and whose
 * sending was not needs to be told that, because the only thing left to fix is
 * one server. The refusal code still collapses to the four the API already
 * maps, so nothing downstream has to learn a new vocabulary — the detail rides
 * on `diagnosis` instead.
 */
export const mailboxResolutionRefusal = (
  resolution: MailboxResolution,
): MailboxConnectionError => {
  const diagnosis: MailboxConnectionDiagnosis = {
    imap: legDiagnosis(resolution.imap),
    smtp: legDiagnosis(resolution.smtp),
  }
  const failures = [resolution.imap, resolution.smtp]
    .filter((leg): leg is Extract<MailboxLegResolution, { ok: false }> => !leg.ok)

  if (failures.some((leg) => leg.failure === 'credential_rejected')) {
    return new MailboxConnectionError(
      'credential_rejected',
      'The email address or password was not accepted.',
      diagnosis,
    )
  }
  if (failures.some((leg) => leg.failure === 'insecure')) {
    const host = failures.find((leg) => leg.failure === 'insecure')?.tried.at(-1)?.host
    return new MailboxConnectionError(
      'invalid_certificate',
      host
        ? `We reached ${host} but could not open a secure connection to it.`
        : 'We cannot connect securely to this mail server.',
      diagnosis,
    )
  }

  // A hostname that produced no candidate at all was refused before any dial —
  // it is not a public mail hostname. Reporting that as "nothing answered"
  // would send somebody hunting for a network fault they do not have.
  if (failures.every((leg) => leg.failure === 'no_candidate')) {
    return new MailboxConnectionError(
      'invalid_address',
      'That mail server name cannot be used. Enter a public host name, such as '
        + 'mail.company.com.',
      diagnosis,
    )
  }

  // Naming the leg that *did* work is the useful half: it tells the person the
  // password is right and the only thing left to fix is one host or port.
  const reached = resolution.imap.ok ? INCOMING : resolution.smtp.ok ? OUTGOING : null
  const missing = resolution.imap.ok ? OUTGOING : INCOMING
  const message = reached === null
    ? 'We could not find a mail server for this address. Enter its settings to continue.'
    : `We connected to your ${reached}, but could not reach an ${missing}. `
      + 'Enter its settings to continue.'
  return new MailboxConnectionError('server_unavailable', message, diagnosis)
}

const MANAGER_ROLES = new Set(['owner', 'admin'])

export type ActingMember = { userId: string; role: string }

/**
 * A team-scope connection needs a team inside the acting organisation. Teams
 * hang off projects, so the organisation is one join away and is checked rather
 * than assumed — the id arrives from a request body.
 */
const assertTeamInOrganization = async (
  prisma: PrismaClient,
  organizationId: string,
  teamId: string,
): Promise<void> => {
  const team = await prisma.team.findFirst({
    select: { id: true },
    where: { id: teamId, project: { organizationId } },
  })
  if (!team) {
    throw new MailboxConnectionError('team_not_found', 'That team is not in this team.')
  }
}

export type CreateMailboxConnectionInput = {
  organizationId: string
  actor: ActingMember
  scope: MailboxConnectionScope
  /** Required for team scope; user scope always binds to the acting person. */
  teamId?: string | null
  label: string
  address: string
  /** Defaults to the address when absent. */
  username?: string | null
  password: string
  /** One hostname for both legs; a leg's own host wins over it. */
  server?: string | null
  /** Anything absent is resolved; anything present is used exactly as given. */
  imapHost?: string | null
  imapPort?: number | null
  imapSecurity?: MailSecurity | null
  smtpHost?: string | null
  smtpPort?: number | null
  smtpSecurity?: MailSecurity | null
}

/**
 * Connect a mailbox.
 *
 * The endpoints are **resolved and proved before anything is written**. A row
 * that has never shown it can read and send is a mailbox an agent will fail at
 * halfway through a task, and the person who connected it would have been told
 * it worked. Resolving first also means a typo in a hostname is a message on
 * the form rather than a broken connection somebody has to notice later.
 *
 * What is stored is what answered, not what was submitted: the caller may send
 * nothing but an address and a password, and the row still carries the exact
 * host, port and transport the successful login used.
 */
export const createMailboxConnection = async (
  prisma: PrismaClient,
  input: CreateMailboxConnectionInput,
  options: { encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput },
): Promise<MailboxConnectionRecord> => {
  if (input.scope === 'team' && !MANAGER_ROLES.has(input.actor.role)) {
    throw new MailboxConnectionError(
      'not_permitted',
      'Only an owner or admin can connect a shared mailbox for a team.',
    )
  }
  const address = normalizeAddress(input.address)
  if (!address) {
    throw new MailboxConnectionError('invalid_address', 'That is not a valid email address.')
  }
  const teamId = input.scope === 'team' ? (input.teamId ?? null) : null
  if (input.scope === 'team') {
    if (!teamId) {
      throw new MailboxConnectionError('team_not_found', 'Choose a team for this mailbox.')
    }
    await assertTeamInOrganization(prisma, input.organizationId, teamId)
  }

  const username = input.username?.trim() || address
  const resolution = await resolveMailboxEndpoints(
    {
      address,
      password: input.password,
      username,
      ...(input.server ? { server: input.server } : {}),
      imap: {
        host: input.imapHost ?? null,
        port: input.imapPort ?? null,
        security: input.imapSecurity ?? null,
      },
      smtp: {
        host: input.smtpHost ?? null,
        port: input.smtpPort ?? null,
        security: input.smtpSecurity ?? null,
      },
    },
    mailboxDialOptions(),
  )
  if (!resolution.imap.ok || !resolution.smtp.ok) throw mailboxResolutionRefusal(resolution)
  const imap = resolution.imap.endpoint
  const smtp = resolution.smtp.endpoint

  try {
    const created = await prisma.$transaction(async (tx) => {
      const connection = await tx.mailboxConnection.create({
        data: {
          address,
          createdByUserId: input.actor.userId,
          imapHost: imap.host,
          imapPort: imap.port,
          imapSecurity: imap.security,
          label: input.label.trim() || address,
          lastVerifiedAt: new Date(),
          organizationId: input.organizationId,
          ownerUserId: input.scope === 'user' ? input.actor.userId : null,
          smtpHost: smtp.host,
          smtpPort: smtp.port,
          smtpSecurity: smtp.security,
          teamId,
          username,
        },
      })
      await tx.mailboxConnectionCredential.create({
        data: {
          connectionId: connection.id,
          secretCiphertext: sealSecret(
            options.encryptionSecret,
            input.password,
            AT_REST_SECRET_PURPOSE.mailboxCredential,
          ),
          keyVersion: toEncryptionKeyRing(options.encryptionSecret).activeVersion,
        },
      })
      return connection
    })
    return presentMailboxConnection({ ...created, agentAccess: [] })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new MailboxConnectionError(
        'address_taken',
        'That mailbox is already connected in this scope.',
      )
    }
    throw error
  }
}

/**
 * Every connection the caller is entitled to see.
 *
 * Scoped by entitlement, never by ambient session context: a member sees their
 * own mailboxes plus the shared ones for teams they belong to, and a manager
 * sees the organisation's shared mailboxes — never another person's personal
 * mailbox, whatever their role.
 */
export const listMailboxConnectionsForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; actor: ActingMember },
): Promise<MailboxConnectionRecord[]> => {
  const teamIds = (
    await prisma.teamMember.findMany({
      select: { teamId: true },
      where: { team: { project: { organizationId: input.organizationId } }, userId: input.actor.userId },
    })
  ).map((row) => row.teamId)

  const teamWhere: Prisma.MailboxConnectionWhereInput = MANAGER_ROLES.has(input.actor.role)
    ? { teamId: { not: null } }
    : { teamId: { in: teamIds } }

  const rows = await prisma.mailboxConnection.findMany({
    include: { agentAccess: { select: { agentId: true } } },
    orderBy: { createdAt: 'asc' },
    where: {
      organizationId: input.organizationId,
      OR: [{ ownerUserId: input.actor.userId }, teamWhere],
    },
  })
  return rows.map(presentMailboxConnection)
}

/**
 * The connection this caller may administer, or a refusal.
 *
 * One predicate behind every mutation — rename, retest, disconnect, and every
 * agent-access change — so the three can never disagree about who is allowed.
 */
export const loadManageableMailboxConnection = async (
  prisma: PrismaClient,
  input: { organizationId: string; actor: ActingMember; connectionId: string },
): Promise<MailboxConnectionRow> => {
  const connection = await prisma.mailboxConnection.findFirst({
    where: { id: input.connectionId, organizationId: input.organizationId },
  })
  if (!connection) {
    throw new MailboxConnectionError('connection_not_found', 'That mailbox connection is gone.')
  }
  const isOwnPersonal = connection.ownerUserId === input.actor.userId
  const isSharedManager = connection.teamId !== null && MANAGER_ROLES.has(input.actor.role)
  if (!isOwnPersonal && !isSharedManager) {
    throw new MailboxConnectionError(
      'not_permitted',
      'Only the person who connected this mailbox, or an owner or admin for a shared one, can change it.',
    )
  }
  return connection
}

/**
 * Re-run the test against the stored credential and record the verdict.
 *
 * A provider rejection flips the connection to `needs_reauthorization` with the
 * remedy in words. Anything else leaves the status alone: a mail server that is
 * briefly unreachable is not a credential a person needs to re-enter, and
 * saying so would send them to fix something that is not broken.
 */
export const verifyMailboxConnection = async (
  prisma: PrismaClient,
  connection: MailboxConnectionRow,
  options: { encryptionSecret: import('@nessie/runtime').EncryptionKeyRingInput },
): Promise<{
  ok: boolean
  detail: string
  failureCode?: Uppercase<MailboxConnectionTestFailure>
}> => {
  const endpoints = await mailboxEndpointsFor(prisma, connection, options.encryptionSecret)
  try {
    const result = await testMailboxConnection(endpoints, mailboxDialOptions())
    await prisma.mailboxConnection.update({
      data: { lastVerifiedAt: new Date(), status: 'active', statusReason: null },
      where: { id: connection.id },
    })
    return {
      detail: `${result.folder} is reachable (${result.messagesVisible} messages) and sending works.`,
      ok: true,
    }
  } catch (error) {
    const failure = mailboxConnectionTestFailure(error)
    const detail = testFailureMessage(failure)
    if (failure === 'credential_rejected') {
      await prisma.mailboxConnection.update({
        data: { status: 'needs_reauthorization', statusReason: detail },
        where: { id: connection.id },
      })
    }
    return { detail, failureCode: failure.toUpperCase() as Uppercase<MailboxConnectionTestFailure>, ok: false }
  }
}

/** Only the provider saying "no" is a credential problem. */
export const isCredentialRejection = (error: unknown): boolean =>
  typeof error === 'object'
  && error !== null
  && 'kind' in error
  && (error as { kind?: string }).kind === 'auth'

export const deleteMailboxConnection = async (
  prisma: PrismaClient,
  connectionId: string,
): Promise<void> => {
  // The credential and every access row cascade with it, so disconnecting is
  // one act rather than three a caller could half-finish.
  await prisma.mailboxConnection.delete({ where: { id: connectionId } })
}

export const setMailboxAgentAccess = async (
  prisma: PrismaClient,
  input: {
    organizationId: string
    connectionId: string
    agentId: string
    grantedByUserId: string
    allowed: boolean
  },
): Promise<void> => {
  if (!input.allowed) {
    await prisma.mailboxConnectionAgentAccess.deleteMany({
      where: { agentId: input.agentId, connectionId: input.connectionId },
    })
    return
  }
  const agent = await prisma.agent.findFirst({
    select: { id: true },
    where: {
      id: input.agentId,
      organizationId: input.organizationId,
      systemManaged: false,
    },
  })
  if (!agent) {
    throw new MailboxConnectionError('agent_not_found', 'That agent is not in this team.')
  }
  await prisma.mailboxConnectionAgentAccess.upsert({
    create: {
      agentId: input.agentId,
      connectionId: input.connectionId,
      grantedByUserId: input.grantedByUserId,
      organizationId: input.organizationId,
    },
    update: {},
    where: {
      connectionId_agentId: { agentId: input.agentId, connectionId: input.connectionId },
    },
  })
}
