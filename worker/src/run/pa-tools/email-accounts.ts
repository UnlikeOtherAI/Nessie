import { Prisma } from '@prisma/client'
import { writeAuditEntry } from '@nessie/db'
import { parseEmailAccountToolArgs } from '@nessie/runtime'
import {
  deleteMailboxConnection,
  disconnectOwnedCommsConnection,
  listManageableMailboxConnectionsForUser,
  listOwnedCommsConnections,
  loadOwnedCommsConnection,
  loadManageableMailboxConnection,
  queueOwnedCommsConnectionSync,
  setMailboxAgentAccess,
  verifyMailboxConnection,
} from '@nessie/team-admin'

import type { BuiltinToolRuntimeContext, ToolExecutionResult } from '../tool-types.js'
import { resolveActingMember, type ActingMember } from './access.js'
import { formatSection } from './tool-output.js'

type EmailAccountKind = 'provider' | 'mailbox'

const requireUuid = (value: unknown, field: string): string => {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) {
    throw new Error(`${field} must be the UUID returned by email_account_list.`)
  }
  return value
}

const requireAccountKind = (value: unknown): EmailAccountKind => {
  if (value !== 'provider' && value !== 'mailbox') {
    throw new Error('accountKind must be "provider" or "mailbox".')
  }
  return value
}

const encryptionSecret = (): string => {
  const secret = process.env.NESSIE_AUTH_SECRET
  if (!secret) throw new Error('NESSIE_AUTH_SECRET is not configured')
  return secret
}

const providerLabel = (provider: string): string =>
  provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : provider

const assertEmailProvider = (provider: string): void => {
  if (provider !== 'google' && provider !== 'microsoft') {
    throw new Error('That provider connection is not an email account.')
  }
}

const audit = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  input: {
    action: string
    metadata: Record<string, unknown>
    resourceId: string
    resourceType: string
  },
): Promise<void> => {
  try {
    await writeAuditEntry(context.prisma, {
      action: input.action,
      actorId: member.userId,
      actorType: 'user',
      channelId: context.channel.id,
      metadata: {
        ...input.metadata,
        delegatedByAgentId: context.agentId,
        runId: context.run.id,
      } as Prisma.InputJsonValue,
      organizationId: member.organizationId,
      outcome: 'success',
      projectId: member.actorContext.tenant.projectId ?? null,
      requestId: member.actorContext.actionContext.requestId,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      teamId: member.actorContext.tenant.teamId ?? null,
    })
  } catch {
    console.error('[email-accounts] Failed to emit lifecycle audit event')
  }
}

/** Lifecycle results name private accounts, addresses, and access decisions. */
const stampLifecycleAccountRead = (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
): void => {
  context.consumedSources?.add({ scopeId: member.userId, scopeType: 'user' })
}

const accountRef = (args: Record<string, unknown>): {
  accountId: string
  accountKind: EmailAccountKind
} => ({
  accountId: requireUuid(args.accountId, 'accountId'),
  accountKind: requireAccountKind(args.accountKind),
})

export const runEmailAccountListTool = async (
  context: BuiltinToolRuntimeContext,
): Promise<ToolExecutionResult> => {
  const member = await resolveActingMember(context)
  const [providerConnections, mailboxes] = await Promise.all([
    listOwnedCommsConnections(context.prisma, {
      organizationId: member.organizationId,
      userId: member.userId,
    }),
    listManageableMailboxConnectionsForUser(context.prisma, {
      actor: { role: member.role, userId: member.userId },
      organizationId: member.organizationId,
    }),
  ])
  // Lifecycle account metadata is private to the person who asked for it.
  // This is deliberately a user basis even when the requester is an org
  // manager viewing a shared mailbox: the response is a management view, not
  // a team conversation export, and an owner need not belong to every team.
  stampLifecycleAccountRead(context, member)
  const providerLines = providerConnections
    .filter(({ connection }) => connection.provider !== 'slack')
    .map(({ connection, resourceCount, syncedResourceCount }) => [
      `- ${providerLabel(connection.provider)} | ${connection.externalUserId}`,
      `  status=${connection.status} | accountKind=provider | accountId=${connection.id}`,
      `  selected folders=${syncedResourceCount}/${resourceCount}`,
      connection.lastSuccessfulSyncAt
        ? `  last successful sync=${connection.lastSuccessfulSyncAt.toISOString()}`
        : '  last successful sync=not yet',
    ].join('\n'))
  const mailboxLines = mailboxes.map((mailbox) => [
    `- ${mailbox.label} | ${mailbox.address}`,
    `  scope=${mailbox.scope} | status=${mailbox.status} | accountKind=mailbox | accountId=${mailbox.id}`,
    `  agents with access=${mailbox.agentIds.join(', ') || 'none'}`,
    mailbox.status === 'needs_reauthorization'
      ? '  status detail=Reconnect this mailbox to restore access.'
      : null,
  ].filter((line): line is string => line !== null).join('\n'))
  const output = [
    formatSection('Provider accounts', providerLines),
    formatSection('IMAP/SMTP mailboxes', mailboxLines),
  ].filter(Boolean).join('\n\n') || 'No email accounts are connected.'
  return {
    inputSummary: 'manageable email accounts',
    outputPreview: output,
    toolName: 'email_account_list',
  }
}

export const runEmailAccountCheckTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const member = await resolveActingMember(context)
  stampLifecycleAccountRead(context, member)
  const ref = accountRef(parseEmailAccountToolArgs('email_account_check', args))
  if (ref.accountKind === 'provider') {
    const connection = await loadOwnedCommsConnection(context.prisma, {
      connectionId: ref.accountId,
      organizationId: member.organizationId,
      userId: member.userId,
    })
    assertEmailProvider(connection.provider)
    const result = await queueOwnedCommsConnectionSync(context.prisma, {
      connectionId: ref.accountId,
      organizationId: member.organizationId,
      userId: member.userId,
    })
    return {
      inputSummary: `accountKind=provider accountId=${ref.accountId}`,
      outputPreview:
        `Queued a ${result.phase} sync for ${providerLabel(result.connection.provider)} `
        + `account ${result.connection.externalUserId}.`,
      toolName: 'email_account_check',
    }
  }

  const connection = await loadManageableMailboxConnection(context.prisma, {
    actor: { role: member.role, userId: member.userId },
    connectionId: ref.accountId,
    organizationId: member.organizationId,
  })
  const result = await verifyMailboxConnection(context.prisma, connection, {
    encryptionSecret: encryptionSecret(),
  })
  return {
    inputSummary: `accountKind=mailbox accountId=${ref.accountId}`,
    outputPreview: result.ok
      ? `${connection.address}: ${result.detail}`
      : `${connection.address}: check failed — ${result.detail}`,
    toolName: 'email_account_check',
  }
}

export const runEmailAccountDisconnectTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const member = await resolveActingMember(context)
  stampLifecycleAccountRead(context, member)
  const ref = accountRef(parseEmailAccountToolArgs('email_account_disconnect', args))
  if (ref.accountKind === 'provider') {
    const connection = await loadOwnedCommsConnection(context.prisma, {
      connectionId: ref.accountId,
      organizationId: member.organizationId,
      userId: member.userId,
    })
    assertEmailProvider(connection.provider)
    const disconnected = await disconnectOwnedCommsConnection(context.prisma, {
      connectionId: ref.accountId,
      encryptionSecret: encryptionSecret(),
      organizationId: member.organizationId,
      userId: member.userId,
    })
    await audit(context, member, {
      action: 'comms.connection.disconnected',
      metadata: { provider: disconnected.provider },
      resourceId: disconnected.connectionId,
      resourceType: 'comms_connection',
    })
    return {
      inputSummary: `accountKind=provider accountId=${ref.accountId}`,
      outputPreview: `Disconnected the ${providerLabel(disconnected.provider)} email account.`,
      toolName: 'email_account_disconnect',
    }
  }

  const connection = await loadManageableMailboxConnection(context.prisma, {
    actor: { role: member.role, userId: member.userId },
    connectionId: ref.accountId,
    organizationId: member.organizationId,
  })
  await deleteMailboxConnection(context.prisma, connection.id)
  await audit(context, member, {
    action: 'mailbox.connection.deleted',
    // The audit row is broadly readable operational history. The mailbox
    // address remains in the private lifecycle response, while the record
    // retains only the structural scope needed to understand the deletion.
    metadata: { scope: connection.ownerUserId ? 'user' : 'team' },
    resourceId: connection.id,
    resourceType: 'mailbox_connection',
  })
  return {
    inputSummary: `accountKind=mailbox accountId=${ref.accountId}`,
    outputPreview: `Disconnected ${connection.address}.`,
    toolName: 'email_account_disconnect',
  }
}

export const runEmailAccountAgentAccessTool = async (
  context: BuiltinToolRuntimeContext,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> => {
  const member = await resolveActingMember(context)
  stampLifecycleAccountRead(context, member)
  const parsed = parseEmailAccountToolArgs('email_account_agent_access', args)
  const connectionId = requireUuid(parsed.accountId, 'accountId')
  const agentId = requireUuid(parsed.agentId, 'agentId')
  const allowed = parsed.allowed === true
  const connection = await loadManageableMailboxConnection(context.prisma, {
    actor: { role: member.role, userId: member.userId },
    connectionId,
    organizationId: member.organizationId,
  })
  await setMailboxAgentAccess(context.prisma, {
    agentId,
    allowed,
    connectionId,
    grantedByUserId: member.userId,
    organizationId: member.organizationId,
  })
  await audit(context, member, {
    action: allowed ? 'mailbox.access.granted' : 'mailbox.access.revoked',
    metadata: { agentId },
    resourceId: connectionId,
    resourceType: 'mailbox_connection',
  })
  return {
    inputSummary: `accountId=${connectionId} agentId=${agentId} allowed=${allowed}`,
    outputPreview:
      `${allowed ? 'Granted' : 'Revoked'} agent ${agentId} `
      + `${allowed ? 'access to' : 'access from'} ${connection.address}. `
      + 'Mailbox tool grants remain a separate setting.',
    toolName: 'email_account_agent_access',
  }
}
