import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import {
  canModifyProject,
  isProjectAccessibleToUser,
  listAccessibleProjectIds,
} from '@nessie/team-admin'

import { sendApiError } from '../src/lib/api.js'
import type { RouteDeps } from '../src/routes/types.js'

/**
 * The route suites for ticket labels, comments and attachments: a real
 * database, the real shared project predicates, and a stand-in realtime hub
 * and file service that record what they were asked to do (removing a ticket
 * file must never reach the file service). The project has its default board
 * and a second board "Dev"; the ticket is on the default. `as` switches the
 * signed-in person between requests.
 */
export type RouteHarness = {
  app: FastifyInstance
  published: { event: string; data: unknown }[]
  deletedFiles: string[]
  as: (userId: string) => void
  ids: {
    organizationId: string
    projectId: string
    defaultBoardId: string
    devBoardId: string
    taskId: string
    memberId: string
    secondMemberId: string
    outsiderId: string
  }
  upload: (uploaderId: string) => Promise<string>
  close: () => Promise<void>
}

export const createRouteHarness = async (
  prisma: PrismaClient,
  register: ((app: FastifyInstance, deps: RouteDeps) => void)[],
): Promise<RouteHarness> => {
  const suffix = randomUUID()
  const users = await Promise.all(['member', 'second', 'outsider'].map((name) =>
    prisma.user.create({ data: { displayName: name, email: `route-${name}-${suffix}@example.test` } })))
  const [member, second, outsider] = users as [typeof users[number], typeof users[number], typeof users[number]]
  const organization = await prisma.organization.create({ data: { name: `route-activity-${suffix}` } })
  await prisma.organizationMember.createMany({
    data: users.map((user) => ({ organizationId: organization.id, role: 'member', userId: user.id })),
  })
  const project = await prisma.project.create({ data: { name: `route-${suffix}`, organizationId: organization.id } })
  await prisma.projectMember.createMany({
    data: [member, second].map((user) => ({ projectId: project.id, userId: user.id })),
  })
  const [defaultBoard, devBoard] = await Promise.all([
    prisma.board.create({
      data: { projectId: project.id, organizationId: organization.id, name: 'Board', isDefault: true, position: 0 },
    }),
    prisma.board.create({
      data: { projectId: project.id, organizationId: organization.id, name: 'Dev', isDefault: false, position: 1 },
    }),
  ])
  const task = await prisma.task.create({
    data: { organizationId: organization.id, projectId: project.id, title: 'Ticket', status: 'inbox' },
  })

  let currentUserId = member.id
  const actorContext = () => ({
    actionContext: { requestId: randomUUID(), uoaIdentity: undefined },
    actor: { actorId: currentUserId, actorType: 'user', roles: ['member'] },
    tenant: { organizationId: organization.id, projectId: project.id },
  })
  const viewer = () => ({ isOrganizationAdmin: false, organizationId: organization.id, userId: currentUserId })
  const published: { event: string; data: unknown }[] = []
  const deletedFiles: string[] = []

  const deps = {
    prisma,
    encryptionKeyRing: {},
    requireActorContext: () => actorContext(),
    requireUserActor: () => true,
    listAccessibleProjectIds: async () => listAccessibleProjectIds(prisma, viewer()),
    isProjectAccessibleToActor: async (_: unknown, projectId: string) =>
      isProjectAccessibleToUser(prisma, viewer(), projectId),
    requireProjectModifier: async (_: unknown, projectId: string, reply: Parameters<typeof sendApiError>[0]) => {
      if (await canModifyProject(prisma, viewer(), projectId)) return true
      sendApiError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found')
      return false
    },
    realtimeHub: {
      publishWs: async (_scopes: unknown, input: { event: string; data: unknown }) => {
        published.push({ event: input.event, data: input.data })
        return input
      },
    },
    fileService: {
      delete: async (attachmentId: string, organizationId: string) => {
        deletedFiles.push(attachmentId)
        const { count } = await prisma.attachment.deleteMany({ where: { id: attachmentId, organizationId } })
        return count > 0
      },
    },
  } as unknown as RouteDeps

  const app = Fastify()
  for (const registerRoutes of register) registerRoutes(app, deps)
  await app.ready()

  return {
    app,
    published,
    deletedFiles,
    as: (userId) => {
      currentUserId = userId
    },
    ids: {
      organizationId: organization.id,
      projectId: project.id,
      defaultBoardId: defaultBoard.id,
      devBoardId: devBoard.id,
      taskId: task.id,
      memberId: member.id,
      secondMemberId: second.id,
      outsiderId: outsider.id,
    },
    upload: async (uploaderId) =>
      (await prisma.attachment.create({
        data: {
          organizationId: organization.id,
          uploaderId,
          kind: 'image',
          mime: 'image/png',
          filename: 'shot.png',
          sizeBytes: BigInt(10),
          storageKey: `test/${randomUUID()}`,
        },
      })).id,
    close: async () => {
      await app.close()
      await prisma.attachment.deleteMany({ where: { organizationId: organization.id } })
      await prisma.organization.deleteMany({ where: { id: organization.id } })
      await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } })
    },
  }
}
