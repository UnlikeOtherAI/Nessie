import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import { isAdminActor, type AuthorizedActionContext } from '@nessie/schemas'
import { listAccessibleProjectIds } from '@nessie/team-admin'

import { sendApiError } from '../src/lib/api.js'
import { registerAccessCheckRoutes } from '../src/routes/access-check.js'
import { registerAccountRoutes } from '../src/routes/accounts.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * A real database for the accounts routes: one organisation with an owner,
 * an admin and two members, a team the first member is in, two agents the
 * member owns and one another member owns privately, and one account in each
 * store — plus a second organisation whose team must never be readable from
 * the first. `as` switches the signed-in person between requests; roles are
 * read from the seat each person holds, as `requireActorContext` re-reads the
 * live membership.
 */

export type Person = 'owner' | 'admin' | 'member' | 'other'

export type AccountsHarness = {
  app: FastifyInstance
  as: (person: Person) => void
  published: string[]
  ids: {
    agentPrivate: string
    agentShared: string
    agentOthers: string
    browserOrganisation: string
    browserTeam: string
    channel: string
    comms: string
    commsOthers: string
    foreignTeam: string
    mailboxPersonal: string
    mailboxShared: string
    organizationId: string
    plan: string
    team: string
    tickets: string
    users: Record<Person, string>
  }
  close: () => Promise<void>
}

const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export const createAccountsHarness = async (prisma: PrismaClient): Promise<AccountsHarness> => {
  const suffix = randomUUID()
  const people: Person[] = ['owner', 'admin', 'member', 'other']
  const created = await Promise.all(people.map((person) => prisma.user.create({
    data: { displayName: `${person} ${suffix.slice(0, 6)}`, email: `accounts-${person}-${suffix}@example.test` },
  })))
  const users = Object.fromEntries(
    people.map((person, index) => [person, created[index]!.id]),
  ) as Record<Person, string>
  const roleOf: Record<Person, string> = { admin: 'admin', member: 'member', other: 'member', owner: 'owner' }

  const organization = await prisma.organization.create({ data: { name: `accounts-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: people.map((person) => ({
      organizationId: organization.id,
      role: roleOf[person] as 'owner' | 'admin' | 'member',
      userId: users[person],
    })),
  })
  const project = await prisma.project.create({ data: { name: `accounts-${suffix}`, organizationId: organization.id } })
  const team = await prisma.team.create({ data: { name: `Support ${suffix.slice(0, 6)}`, projectId: project.id } })
  await prisma.teamMember.create({ data: { teamId: team.id, userId: users.member } })
  // A public conversation nobody has put an agent in.
  const channel = await prisma.channel.create({
    data: {
      label: 'general',
      slug: `general-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      visibility: 'public',
    },
  })

  const foreignOrganization = await prisma.organization.create({ data: { name: `accounts-foreign-${suffix}` } })
  const foreignProject = await prisma.project.create({
    data: { name: `accounts-foreign-${suffix}`, organizationId: foreignOrganization.id },
  })
  const foreignTeam = await prisma.team.create({ data: { name: 'Foreign', projectId: foreignProject.id } })

  const plan = await prisma.modelSubscription.create({
    data: {
      accountLabel: 'member@kimi.test',
      organizationId: organization.id,
      provider: 'kimi',
      providerAccountId: `kimi-${suffix}`,
      userId: users.member,
    },
  })
  const [agentShared, agentPrivate, agentOthers] = await Promise.all([
    prisma.agent.create({
      data: {
        name: 'Scout',
        organizationId: organization.id,
        ownerUserId: users.member,
        toolPolicy: { mailbox_read: true },
        visibility: 'team',
      },
    }),
    prisma.agent.create({
      data: {
        modelSubscriptionId: plan.id,
        name: 'Diary',
        organizationId: organization.id,
        ownerUserId: users.member,
        provider: 'subscription/kimi',
        visibility: 'private',
      },
    }),
    prisma.agent.create({
      data: { name: 'Secret', organizationId: organization.id, ownerUserId: users.other, visibility: 'private' },
    }),
  ])

  const [comms, commsOthers] = await Promise.all([
    prisma.commsConnection.create({
      data: {
        externalTenantId: 'example.test',
        externalUserId: 'member@example.test',
        grantedScopes: [GMAIL_READ_SCOPE],
        organizationId: organization.id,
        ownerUserId: users.member,
        provider: 'google',
      },
    }),
    prisma.commsConnection.create({
      data: {
        externalTenantId: 'example.test',
        externalUserId: 'other@example.test',
        organizationId: organization.id,
        ownerUserId: users.other,
        provider: 'google',
      },
    }),
  ])

  const mailbox = {
    imapHost: 'imap.example.test',
    imapPort: 993,
    organizationId: organization.id,
    smtpHost: 'smtp.example.test',
    smtpPort: 587,
  }
  const [mailboxPersonal, mailboxShared] = await Promise.all([
    prisma.mailboxConnection.create({
      data: {
        ...mailbox,
        address: 'member@example.test',
        createdByUserId: users.member,
        label: 'My mail',
        ownerUserId: users.member,
        username: 'member@example.test',
      },
    }),
    prisma.mailboxConnection.create({
      data: {
        ...mailbox,
        address: 'support@example.test',
        createdByUserId: users.admin,
        label: 'Support',
        status: 'needs_reauthorization',
        teamId: team.id,
        username: 'support@example.test',
      },
    }),
  ])
  await prisma.mailboxConnectionAgentAccess.create({
    data: {
      agentId: agentShared.id,
      connectionId: mailboxShared.id,
      grantedByUserId: users.admin,
      organizationId: organization.id,
    },
  })

  const tickets = await prisma.boardSourceConnection.create({
    data: {
      externalAccountId: 'member@jira.test',
      externalTenantId: 'acme.atlassian.net',
      organizationId: organization.id,
      ownerUserId: users.member,
      provider: 'jira',
      status: 'needs_reauthorization',
    },
  })

  const [browserTeam, browserOrganisation] = await Promise.all([
    prisma.cloudBrowserConnection.create({
      data: {
        apiKeyRef: `secret_browserbase_${suffix}`,
        createdByUserId: users.owner,
        organizationId: organization.id,
        scope: 'team',
        teamId: team.id,
      },
    }),
    prisma.cloudBrowserConnection.create({
      data: {
        apiKeyRef: `secret_browserbase_org_${suffix}`,
        createdByUserId: users.owner,
        healthReason: 'auth_failed',
        organizationId: organization.id,
        scope: 'organization',
        status: 'needs_attention',
      },
    }),
  ])

  let current: Person = 'member'
  const actor = (): AuthorizedActionContext => ({
    actionContext: { requestId: randomUUID() },
    actor: { actorId: users[current], actorType: 'user', roles: [roleOf[current]] },
    tenant: { organizationId: organization.id },
  }) as unknown as AuthorizedActionContext
  const published: string[] = []

  const deps = {
    listAccessibleProjectIds: async () => listAccessibleProjectIds(prisma, {
      isOrganizationAdmin: current === 'owner' || current === 'admin',
      organizationId: organization.id,
      userId: users[current],
    }),
    prisma,
    realtimeHub: {
      publishWs: async (_scopes: unknown, input: { event: string }) => {
        published.push(input.event)
        return input
      },
    },
    requireActorContext: () => actor(),
    requireOrgAdmin: (context: AuthorizedActionContext, reply: Parameters<typeof sendApiError>[0]) => {
      if (isAdminActor(context)) return true
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner or admin access required')
      return false
    },
    requireOwner: (context: AuthorizedActionContext, reply: Parameters<typeof sendApiError>[0]) => {
      if (context.actor.roles?.includes('owner')) return true
      sendApiError(reply, 403, 'FORBIDDEN', 'Owner access required')
      return false
    },
    requireUserActor: () => true,
  } as unknown as RouteDeps

  const app = Fastify()
  registerAccountRoutes(app, deps)
  registerAccessCheckRoutes(app, deps)
  await app.ready()

  return {
    app,
    as: (person) => { current = person },
    close: async () => {
      await app.close()
      await prisma.organization.deleteMany({ where: { id: { in: [organization.id, foreignOrganization.id] } } })
      await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } })
    },
    ids: {
      agentOthers: agentOthers.id,
      agentPrivate: agentPrivate.id,
      agentShared: agentShared.id,
      browserOrganisation: browserOrganisation.id,
      browserTeam: browserTeam.id,
      channel: channel.id,
      comms: comms.id,
      commsOthers: commsOthers.id,
      foreignTeam: foreignTeam.id,
      mailboxPersonal: mailboxPersonal.id,
      mailboxShared: mailboxShared.id,
      organizationId: organization.id,
      plan: plan.id,
      team: team.id,
      tickets: tickets.id,
      users,
    },
    published,
  }
}
