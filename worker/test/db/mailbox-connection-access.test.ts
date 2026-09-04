import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import {
  MailboxAccessError,
  listMailboxConnectionsForUser,
  listManageableMailboxConnectionsForUser,
  loadManageableMailboxConnection,
  MailboxConnectionError,
  resolveMailboxForToolCall,
} from '@nessie/team-admin'

import { runDatabaseTest } from './support.js'

/**
 * Which connected mailbox a run may touch, against the real database.
 *
 * These are the two gates that stand between a shared agent and somebody's
 * correspondence — the per-pair access row and, for a personal mailbox, the
 * effective user — plus the entitlement rules the API's list and mutate routes
 * ask. All four are Prisma predicates, so a stubbed client would only be
 * testing the stub.
 */

type Seed = {
  organizationId: string
  teamId: string
  agentId: string
  otherAgentId: string
  personId: string
  otherPersonId: string
}

const seed = async (prisma: PrismaClient): Promise<Seed> => {
  const org = await prisma.organization.create({ data: { name: `mbx-conn ${randomUUID()}` } })
  const project = await prisma.project.create({ data: { name: 'p', organizationId: org.id } })
  const team = await prisma.team.create({ data: { name: 't', projectId: project.id } })
  const makePerson = async (role: string) => {
    const user = await prisma.user.create({
      data: { displayName: 'Person', email: `${randomUUID()}@example.test` },
    })
    await prisma.organizationMember.create({
      data: { organizationId: org.id, role, userId: user.id },
    })
    return user.id
  }
  const makeAgent = async (name: string) =>
    (await prisma.agent.create({
      data: {
        name,
        organizationId: org.id,
        projectId: project.id,
        role: 'assistant',
        teamId: team.id,
      },
    })).id

  return {
    agentId: await makeAgent('Reader'),
    organizationId: org.id,
    otherAgentId: await makeAgent('Stranger'),
    otherPersonId: await makePerson('member'),
    personId: await makePerson('member'),
    teamId: team.id,
  }
}

const connect = async (
  prisma: PrismaClient,
  input: Seed & { ownerUserId?: string; teamId?: string; label: string; status?: string },
) =>
  prisma.mailboxConnection.create({
    data: {
      address: `${randomUUID().slice(0, 8)}@example.test`,
      createdByUserId: input.personId,
      imapHost: 'imap.example.test',
      imapPort: 993,
      label: input.label,
      organizationId: input.organizationId,
      ownerUserId: input.ownerUserId ?? null,
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      status: (input.status ?? 'active') as 'active',
      teamId: input.ownerUserId ? null : input.teamId,
      username: 'agent',
    },
  })

const grant = (prisma: PrismaClient, seeded: Seed, connectionId: string, agentId: string) =>
  prisma.mailboxConnectionAgentAccess.create({
    data: { agentId, connectionId, organizationId: seeded.organizationId },
  })

const cleanup = (prisma: PrismaClient, organizationId: string) =>
  prisma.organization.delete({ where: { id: organizationId } }).catch(() => undefined)

runDatabaseTest('a tool grant alone reaches no mailbox — the access row is separate', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    await connect(prisma, { ...seeded, label: 'Team inbox' })
    await assert.rejects(
      resolveMailboxForToolCall(prisma, {
        agentId: seeded.agentId,
        effectiveUserId: seeded.personId,
        organizationId: seeded.organizationId,
      }),
      (error: unknown) => error instanceof MailboxAccessError && error.code === 'NO_MAILBOX',
      'connecting a mailbox must not hand it to every agent holding the tools',
    )
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a personal mailbox resolves only for a run acting as its owner', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const connection = await connect(prisma, {
      ...seeded,
      label: 'My mail',
      ownerUserId: seeded.personId,
    })
    await grant(prisma, seeded, connection.id, seeded.agentId)

    const mine = await resolveMailboxForToolCall(prisma, {
      agentId: seeded.agentId,
      effectiveUserId: seeded.personId,
      organizationId: seeded.organizationId,
    })
    assert.equal(mine.connection.id, connection.id)
    assert.equal(mine.scope, 'user')
    assert.deepEqual(
      mine.basis,
      { scopeId: seeded.personId, scopeType: 'user' },
      'a read of a personal mailbox restricts the reply to its owner',
    )

    for (const effectiveUserId of [seeded.otherPersonId, null]) {
      await assert.rejects(
        resolveMailboxForToolCall(prisma, {
          agentId: seeded.agentId,
          effectiveUserId,
          organizationId: seeded.organizationId,
        }),
        (error: unknown) => error instanceof MailboxAccessError && error.code === 'NO_MAILBOX',
        `an access row is not enough for effectiveUserId=${String(effectiveUserId)}`,
      )
    }
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a team mailbox resolves for an unattended run and stamps its team', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const connection = await connect(prisma, { ...seeded, label: 'Support' })
    await grant(prisma, seeded, connection.id, seeded.agentId)

    const shared = await resolveMailboxForToolCall(prisma, {
      agentId: seeded.agentId,
      effectiveUserId: null,
      organizationId: seeded.organizationId,
    })
    assert.equal(shared.scope, 'team')
    assert.deepEqual(shared.basis, { scopeId: seeded.teamId, scopeType: 'team' })
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('two reachable mailboxes refuse rather than guess', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const first = await connect(prisma, { ...seeded, label: 'Support' })
    const second = await connect(prisma, {
      ...seeded,
      label: 'Mine',
      ownerUserId: seeded.personId,
    })
    await grant(prisma, seeded, first.id, seeded.agentId)
    await grant(prisma, seeded, second.id, seeded.agentId)

    await assert.rejects(
      resolveMailboxForToolCall(prisma, {
        agentId: seeded.agentId,
        effectiveUserId: seeded.personId,
        organizationId: seeded.organizationId,
      }),
      (error: unknown) =>
        error instanceof MailboxAccessError && error.code === 'AMBIGUOUS_MAILBOX',
      'sending from the wrong address is not recoverable',
    )

    const named = await resolveMailboxForToolCall(prisma, {
      agentId: seeded.agentId,
      connectionId: second.id,
      effectiveUserId: seeded.personId,
      organizationId: seeded.organizationId,
    })
    assert.equal(named.connection.id, second.id, 'naming one resolves it')

    await assert.rejects(
      resolveMailboxForToolCall(prisma, {
        agentId: seeded.otherAgentId,
        connectionId: second.id,
        effectiveUserId: seeded.personId,
        organizationId: seeded.organizationId,
      }),
      (error: unknown) => error instanceof MailboxAccessError && error.code === 'NO_MAILBOX',
      'naming a mailbox is not a way to reach one you were never granted',
    )
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a mailbox needing reauthorization is absent, not present-and-failing', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const connection = await connect(prisma, {
      ...seeded,
      label: 'Broken',
      status: 'needs_reauthorization',
    })
    await grant(prisma, seeded, connection.id, seeded.agentId)
    await assert.rejects(
      resolveMailboxForToolCall(prisma, {
        agentId: seeded.agentId,
        effectiveUserId: null,
        organizationId: seeded.organizationId,
      }),
      (error: unknown) => error instanceof MailboxAccessError && error.code === 'NO_MAILBOX',
    )
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('an owner never sees or manages somebody else’s personal mailbox', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const personal = await connect(prisma, {
      ...seeded,
      label: 'Private',
      ownerUserId: seeded.otherPersonId,
    })
    const shared = await connect(prisma, { ...seeded, label: 'Support' })

    const asOwner = await listMailboxConnectionsForUser(prisma, {
      actor: { role: 'owner', userId: seeded.personId },
      organizationId: seeded.organizationId,
    })
    assert.deepEqual(
      asOwner.map((row) => row.id),
      [shared.id],
      'org-wide reach covers shared mailboxes, never a colleague’s own',
    )

    await assert.rejects(
      loadManageableMailboxConnection(prisma, {
        actor: { role: 'owner', userId: seeded.personId },
        connectionId: personal.id,
        organizationId: seeded.organizationId,
      }),
      (error: unknown) =>
        error instanceof MailboxConnectionError && error.refusal === 'not_permitted',
    )

    const asOwnerOfIt = await loadManageableMailboxConnection(prisma, {
      actor: { role: 'member', userId: seeded.otherPersonId },
      connectionId: personal.id,
      organizationId: seeded.organizationId,
    })
    assert.equal(asOwnerOfIt.id, personal.id, 'its own owner manages it without a role')

    await assert.rejects(
      loadManageableMailboxConnection(prisma, {
        actor: { role: 'member', userId: seeded.personId },
        connectionId: shared.id,
        organizationId: seeded.organizationId,
      }),
      (error: unknown) =>
        error instanceof MailboxConnectionError && error.refusal === 'not_permitted',
      'a shared mailbox is an owner or admin decision',
    )
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('a member sees a shared mailbox only for a team they belong to', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const shared = await connect(prisma, { ...seeded, label: 'Support' })

    const before = await listMailboxConnectionsForUser(prisma, {
      actor: { role: 'member', userId: seeded.personId },
      organizationId: seeded.organizationId,
    })
    assert.deepEqual(before, [], 'a team mailbox is not team-wide')

    await prisma.teamMember.create({
      data: { teamId: seeded.teamId, userId: seeded.personId },
    })
    const after = await listMailboxConnectionsForUser(prisma, {
      actor: { role: 'member', userId: seeded.personId },
      organizationId: seeded.organizationId,
    })
    assert.deepEqual(after.map((row) => row.id), [shared.id])
    assert.equal(
      Object.prototype.hasOwnProperty.call(after[0] ?? {}, 'password'),
      false,
      'nothing on the presented shape carries a credential',
    )
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})

runDatabaseTest('the management list never advertises a shared mailbox to a member', async () => {
  const prisma = new PrismaClient()
  const seeded = await seed(prisma)
  try {
    const personal = await connect(prisma, {
      ...seeded,
      label: 'Personal',
      ownerUserId: seeded.personId,
    })
    const shared = await connect(prisma, { ...seeded, label: 'Support' })
    await prisma.teamMember.create({
      data: { teamId: seeded.teamId, userId: seeded.personId },
    })

    const visible = await listMailboxConnectionsForUser(prisma, {
      actor: { role: 'member', userId: seeded.personId },
      organizationId: seeded.organizationId,
    })
    assert.deepEqual(
      visible.map((row) => row.id).sort(),
      [personal.id, shared.id].sort(),
    )

    const manageableByMember = await listManageableMailboxConnectionsForUser(prisma, {
      actor: { role: 'member', userId: seeded.personId },
      organizationId: seeded.organizationId,
    })
    assert.deepEqual(manageableByMember.map((row) => row.id), [personal.id])

    const manageableByAdmin = await listManageableMailboxConnectionsForUser(prisma, {
      actor: { role: 'admin', userId: seeded.personId },
      organizationId: seeded.organizationId,
    })
    assert.deepEqual(
      manageableByAdmin.map((row) => row.id).sort(),
      [personal.id, shared.id].sort(),
    )
  } finally {
    await cleanup(prisma, seeded.organizationId)
    await prisma.$disconnect()
  }
})
