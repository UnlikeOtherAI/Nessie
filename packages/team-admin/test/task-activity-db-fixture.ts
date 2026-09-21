import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'

import type { BoardRef, TaskActor } from '../src/index.js'

/**
 * One organisation with a project, three people and two tickets — one native,
 * one mirrored from a Linear source — for the label, comment and attachment
 * suites. The project has two boards, its default ("Board") and "Dev", each
 * with one To-do column; both tickets are on the default (`boardId: null`).
 * The other project has a default board of its own. Cleanup is this seed's
 * own organisation and users only.
 */
export type TaskActivitySeed = {
  organizationId: string
  projectId: string
  otherProjectId: string
  /** The project's default board, and a second board "Dev". */
  board: BoardRef
  devBoard: BoardRef
  otherProjectBoard: BoardRef
  boardColumnId: string
  devColumnId: string
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
  const makeBoard = async (projectId: string, name: string, isDefault: boolean, position: number) => {
    const board = await prisma.board.create({
      data: { projectId, organizationId: organization.id, name, isDefault, position },
      select: { id: true, projectId: true, organizationId: true },
    })
    const column = await prisma.boardColumn.create({
      data: { boardId: board.id, organizationId: organization.id, name: 'To do', category: 'todo', position: 0 },
      select: { id: true },
    })
    return { board, columnId: column.id }
  }
  const defaultBoard = await makeBoard(project.id, 'Board', true, 0)
  const devBoard = await makeBoard(project.id, 'Dev', false, 1)
  const otherProjectBoard = await makeBoard(otherProject.id, 'Board', true, 0)
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
    board: defaultBoard.board,
    devBoard: devBoard.board,
    otherProjectBoard: otherProjectBoard.board,
    boardColumnId: defaultBoard.columnId,
    devColumnId: devBoard.columnId,
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

/** A label row as a board source or a person left it. */
export const createLabel = (
  prisma: PrismaClient,
  board: BoardRef,
  name: string,
  owner: { sourceId: string; externalId: string } | null = null,
  color = '#6b7280',
) =>
  prisma.taskLabel.create({
    data: {
      organizationId: board.organizationId,
      projectId: board.projectId,
      boardId: board.id,
      name,
      normalizedName: name.trim().toLowerCase(),
      color,
      sourceId: owner?.sourceId ?? null,
      externalId: owner?.externalId ?? null,
    },
  })

export const eventsOf = async (prisma: PrismaClient, taskId: string, eventType: string) =>
  (await prisma.taskEvent.findMany({ where: { taskId, eventType }, orderBy: { createdAt: 'asc' } }))
    .map((event) => event.payload as Record<string, unknown>)
