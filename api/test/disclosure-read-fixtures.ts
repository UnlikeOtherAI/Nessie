import { PrismaClient } from '@prisma/client'

export type Seed = {
  organizationId: string
  projectId: string
  teamId: string
  channelId: string
  threadId: string
  agentId: string
  insiderId: string
  outsiderId: string
}

// One organisation, one channel, two people in it, and one agent. `insider` is
// additionally a member of the private channel a restricted reply is derived
// from; `outsider` is not. Both can see the thread the reply lands in — that is
// the whole point: thread visibility is not entitlement to the content.
export const seed = async (prisma: PrismaClient, suffix: string): Promise<Seed> => {
  const organization = await prisma.organization.create({
    data: { name: `disclosure-org-${suffix}` },
  })
  const project = await prisma.project.create({
    data: { name: `p-${suffix}`, organizationId: organization.id },
  })
  const team = await prisma.team.create({
    data: { name: `t-${suffix}`, projectId: project.id },
  })
  const channel = await prisma.channel.create({
    data: {
      label: `c-${suffix}`,
      // `channels_standard_slug_required` — a standard channel must be addressable.
      slug: `c-${suffix.slice(0, 8)}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
      type: 'standard',
      visibility: 'public',
    },
  })
  const thread = await prisma.thread.create({
    data: { channelId: channel.id, title: 'main' },
  })
  const agent = await prisma.agent.create({
    data: {
      name: `a-${suffix}`,
      organizationId: organization.id,
      projectId: project.id,
      teamId: team.id,
    },
  })

  const makeUser = async (role: string) => {
    const user = await prisma.user.create({
      data: { email: `${role}-${suffix}@example.com`, displayName: role },
    })
    await prisma.organizationMember.create({
      data: { organizationId: organization.id, userId: user.id, role: 'member' },
    })
    await prisma.channelMember.create({ data: { channelId: channel.id, userId: user.id } })
    return user.id
  }

  return {
    agentId: agent.id,
    channelId: channel.id,
    insiderId: await makeUser('insider'),
    organizationId: organization.id,
    outsiderId: await makeUser('outsider'),
    projectId: project.id,
    teamId: team.id,
    threadId: thread.id,
  }
}

