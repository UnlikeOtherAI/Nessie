import { Prisma, type PrismaClient } from '@prisma/client'
import {
  ImapError,
  MailDialError,
  MailWireError,
  normalizeAddress,
  SmtpError,
  testMailboxConnection,
  type MailSecurity,
} from '@nessie/agent-mail'
// The record and scope shapes are the wire contract, so they live in
// `@nessie/schemas` and are imported here rather than restated — the API
// response and this presenter are one type by construction.
import type {
  MailboxConnectionRecord,
  MailboxConnectionScope,
} from '@nessie/schemas'
import { sealSecret } from '@nessie/comms-connect'

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

/**
 * The only diagnostics we persist or show for a mailbox connection.
 *
 * Protocol error text is untrusted provider input: it can include credentials,
 * host details, or instructions written by a remote server. Keep the failure
 * classification, never the provider's wording.
 */
export const mailboxConnectionFailureMessage = (
  failure: MailboxConnectionTestFailure,
): string => {
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
 * Old rows may predate the structural-diagnostics boundary. A presenter is a
 * security boundary too, so it derives the remedy from status instead of ever
 * returning the stored text verbatim.
 */
const mailboxConnectionStatusMessage = (
  status: MailboxConnectionRecord['status'],
): string | null =>
  status === 'needs_reauthorization'
    ? mailboxConnectionFailureMessage('credential_rejected')
    : null

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
  statusReason: mailboxConnectionStatusMessage(connection.status),
  teamId: connection.teamId,
  username: connection.username,
})

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
  username: string
  password: string
  imapHost: string
  imapPort: number
  imapSecurity: MailSecurity
  smtpHost: string
  smtpPort: number
  smtpSecurity: MailSecurity
}

/**
 * Connect a mailbox.
 *
 * The connection is **tested before anything is written**. A row that has never
 * proved it can read and send is a mailbox an agent will fail at halfway
 * through a task, and the person who connected it would have been told it
 * worked. Testing first also means a typo in a hostname is a message on the
 * form rather than a broken connection somebody has to notice later.
 */
export const createMailboxConnection = async (
  prisma: PrismaClient,
  input: CreateMailboxConnectionInput,
  options: { encryptionSecret: string },
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

  const endpoints = {
    address,
    imap: { host: input.imapHost, port: input.imapPort, security: input.imapSecurity },
    password: input.password,
    smtp: { host: input.smtpHost, port: input.smtpPort, security: input.smtpSecurity },
    username: input.username,
  }
  try {
    await testMailboxConnection(endpoints, mailboxDialOptions())
  } catch (error) {
    const failure = mailboxConnectionTestFailure(error)
    throw new MailboxConnectionError(
      failure,
      mailboxConnectionFailureMessage(failure),
    )
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const connection = await tx.mailboxConnection.create({
        data: {
          address,
          createdByUserId: input.actor.userId,
          imapHost: input.imapHost,
          imapPort: input.imapPort,
          imapSecurity: input.imapSecurity,
          label: input.label.trim() || address,
          lastVerifiedAt: new Date(),
          organizationId: input.organizationId,
          ownerUserId: input.scope === 'user' ? input.actor.userId : null,
          smtpHost: input.smtpHost,
          smtpPort: input.smtpPort,
          smtpSecurity: input.smtpSecurity,
          teamId,
          username: input.username,
        },
      })
      await tx.mailboxConnectionCredential.create({
        data: {
          connectionId: connection.id,
          secretCiphertext: sealSecret(options.encryptionSecret, input.password),
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
 * Connections the caller can mutate through the account-management surface.
 *
 * This deliberately differs from `listMailboxConnectionsForUser`: membership
 * grants visibility of a shared mailbox, but not authority to alter it. The
 * Personal Assistant uses this list because every returned id is actionable by
 * its lifecycle tools.
 */
export const listManageableMailboxConnectionsForUser = async (
  prisma: PrismaClient,
  input: { organizationId: string; actor: ActingMember },
): Promise<MailboxConnectionRecord[]> => {
  const sharedWhere: Prisma.MailboxConnectionWhereInput = MANAGER_ROLES.has(input.actor.role)
    ? { teamId: { not: null } }
    : { id: { in: [] } }
  const rows = await prisma.mailboxConnection.findMany({
    include: { agentAccess: { select: { agentId: true } } },
    orderBy: { createdAt: 'asc' },
    where: {
      organizationId: input.organizationId,
      OR: [{ ownerUserId: input.actor.userId }, sharedWhere],
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
  options: { encryptionSecret: string },
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
    const detail = mailboxConnectionFailureMessage(failure)
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
