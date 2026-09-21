import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import type { LedgerAttribution } from '@nessie/runtime'

import type { TaskActor } from '../src/index.js'

/**
 * One organisation with a project, three people and two tickets — one native,
 * one mirrored from a Linear source — for the label, comment and attachment
 * suites. Cleanup is this seed's own organisation and users only.
 */
export type TaskActivitySeed = {
  organizationId: string
  projectId: string
  otherProjectId: string
  sourceId: string
  otherSourceId: string
  nativeTaskId: string
  mirroredTaskId: string
  agentId: string
  memberId: string
  secondMemberId: string
  outsiderId: string
  userIds: string[]
  member: TaskActor
  secondMember: TaskActor
  outsider: TaskActor
  cleanup: () => Promise<void>
}

export const seedTaskActivity = async (
  prisma: PrismaClient,
  options: { writeMode?: 'read_only' | 'read_write' } = {},
): Promise<TaskActivitySeed> => {
  const suffix = randomUUID()
  const [member, secondMember, outsider] = await Promise.all(
    ['member', 'second', 'outsider'].map((name) =>
      prisma.user.create({ data: { displayName: name, email: `task-activity-${name}-${suffix}@example.test` } })),
  )
  const organization = await prisma.organization.create({ data: { name: `task-activity-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: [member!, secondMember!, outsider!].map((user) => ({
      organizationId: organization.id,
      role: 'member',
      userId: user.id,
    })),
  })
  const project = await prisma.project.create({ data: { name: `activity-${suffix}`, organizationId: organization.id } })
  const otherProject = await prisma.project.create({ data: { name: `activity-other-${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [member!, secondMember!].map((user) => ({ projectId: project.id, userId: user.id, role: 'member' })),
  })
  const team = await prisma.team.create({ data: { name: `activity-team-${suffix}`, projectId: project.id } })
  const agent = await prisma.agent.create({
    data: { name: `activity-agent-${suffix}`, organizationId: organization.id, projectId: project.id, teamId: team.id },
  })
  const connection = await prisma.boardSourceConnection.create({
    data: {
      organizationId: organization.id,
      ownerUserId: member!.id,
      provider: 'linear',
      externalAccountId: `acct-${suffix}`,
    },
  })
  const makeSource = (key: string) =>
    prisma.boardSource.create({
      data: {
        projectId: project.id,
        organizationId: organization.id,
        connectionId: connection.id,
        provider: 'linear',
        name: `Linear ${key}`,
        container: { teamId: key },
        containerKey: `${key}-${suffix}`,
        writeMode: options.writeMode ?? 'read_only',
        createdByUserId: member!.id,
      },
    })
  const source = await makeSource('team-a')
  const otherSource = await makeSource('team-b')
  const nativeTask = await prisma.task.create({
    data: { organizationId: organization.id, projectId: project.id, title: 'Native', status: 'inbox', detail: 'Plain' },
  })
  const mirroredTask = await prisma.task.create({
    data: { organizationId: organization.id, projectId: project.id, title: 'Mirrored', status: 'inbox' },
  })
  await prisma.taskExternalLink.create({
    data: {
      organizationId: organization.id,
      taskId: mirroredTask.id,
      sourceId: source.id,
      externalId: `issue-${suffix}`,
      externalKey: 'ENG-1',
      externalUrl: 'https://linear.app/x/issue/ENG-1',
    },
  })
  const actor = (userId: string): TaskActor => ({
    organizationId: organization.id,
    userId,
    isOrganizationAdmin: false,
  })
  const userIds = [member!.id, secondMember!.id, outsider!.id]
  return {
    organizationId: organization.id,
    projectId: project.id,
    otherProjectId: otherProject.id,
    sourceId: source.id,
    otherSourceId: otherSource.id,
    nativeTaskId: nativeTask.id,
    mirroredTaskId: mirroredTask.id,
    agentId: agent.id,
    memberId: member!.id,
    secondMemberId: secondMember!.id,
    outsiderId: outsider!.id,
    userIds,
    member: actor(member!.id),
    secondMember: actor(secondMember!.id),
    outsider: actor(outsider!.id),
    cleanup: async () => {
      await prisma.attachment.deleteMany({ where: { organizationId: organization.id } })
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    },
  }
}

/** An unlinked upload, exactly as `POST /api/uploads` leaves it. */
export const createUpload = async (
  prisma: PrismaClient,
  seed: Pick<TaskActivitySeed, 'organizationId'>,
  uploaderId: string,
) =>
  prisma.attachment.create({
    data: {
      organizationId: seed.organizationId,
      uploaderId,
      kind: 'image',
      mime: 'image/png',
      filename: 'shot.png',
      sizeBytes: BigInt(1234),
      storageKey: `test/${randomUUID()}`,
    },
  })

/** A stand-in file service: records every delete and removes the row, as the real one does. */
export const recordingFileService = (prisma: PrismaClient) => {
  const deleted: string[] = []
  return {
    deleted,
    fileService: {
      delete: async (attachmentId: string, organizationId: string) => {
        deleted.push(attachmentId)
        const { count } = await prisma.attachment.deleteMany({ where: { id: attachmentId, organizationId } })
        return count > 0
      },
    },
    attribution: { organizationId: 'test' } as unknown as LedgerAttribution,
  }
}

export const eventsOf = async (prisma: PrismaClient, taskId: string, eventType: string) =>
  (await prisma.taskEvent.findMany({ where: { taskId, eventType }, orderBy: { createdAt: 'asc' } }))
    .map((event) => event.payload as Record<string, unknown>)
