import type { PrismaClient } from '@prisma/client'
import type { UoaSessionIdentity } from '@nessie/schemas'
import {
  archiveProjectDoneTasks,
  assignProjectTask,
  createProjectTask,
  createBoardSourceWriteBack,
  createProjectTaskAssignmentAttention,
  getProjectTask,
  isProjectTaskTransitionValid,
  listAssignableProjectTaskUsers,
  listProjectTasks,
  moveProjectTaskToColumn,
  projectTaskVisibilityWhere,
  resolveProjectTaskDetailPlacement,
  setProjectTaskIteration,
  transitionProjectTask,
  updateProjectTask,
  type CreateProjectTaskInput,
  type ProjectTaskUpdateFields,
  type ProjectTaskVisibility,
} from '@nessie/team-admin'

import { canUserReadRunDerivedRecord } from './run-derived-read.js'

// These route-facing names keep their established API while the work itself is
// shared with the personal assistant in @nessie/team-admin.
export type TaskVisibility = ProjectTaskVisibility
export type TaskUpdateFields = ProjectTaskUpdateFields

export const taskVisibilityWhere = projectTaskVisibilityWhere
export const listTasks = async (
  prisma: PrismaClient,
  organizationId: string,
  filters: Parameters<typeof listProjectTasks>[2],
  visibility: ProjectTaskVisibility | undefined,
  userId: string,
  uoaIdentity: UoaSessionIdentity | undefined,
) => {
  const tasks = await listProjectTasks(prisma, organizationId, filters, visibility)
  const readable = await Promise.all(tasks.map(async (task) => ({
    readable: await canUserReadRunDerivedRecord(prisma, {
      organizationId,
      runId: task.runId,
      uoaIdentity,
      userId,
    }),
    task,
  })))
  return readable.filter(({ readable }) => readable).map(({ task }) => task)
}

export const getTask = async (
  prisma: PrismaClient,
  taskId: string,
  organizationId: string,
  visibility: ProjectTaskVisibility | undefined,
  userId: string,
  uoaIdentity: UoaSessionIdentity | undefined,
) => {
  const task = await getProjectTask(prisma, taskId, organizationId, visibility)
  if (!task || !(await canUserReadRunDerivedRecord(prisma, {
    organizationId,
    runId: task.runId,
    uoaIdentity,
    userId,
  }))) return null
  return task
}

/**
 * The detail projection remains entitlement-gated before its board lookup.
 * The board/column comes from the same resolver used to draw board cards.
 */
export const getTaskDetail = async (
  prisma: PrismaClient,
  taskId: string,
  organizationId: string,
  visibility: ProjectTaskVisibility | undefined,
  userId: string,
  uoaIdentity: UoaSessionIdentity | undefined,
) => {
  const task = await getTask(prisma, taskId, organizationId, visibility, userId, uoaIdentity)
  if (!task) return null
  return {
    ...task,
    boardPlacement: await resolveProjectTaskDetailPlacement(prisma, task),
  }
}
export const listAssignableUsers = listAssignableProjectTaskUsers
export const isValidTransition = isProjectTaskTransitionValid
export const setTaskIteration = setProjectTaskIteration
export const transitionTask = transitionProjectTask

/**
 * The three mutations a source can own take the write-back collaborator. It is
 * built once per request from the shared adapter registry, so a person's drag
 * and the personal assistant's `ticket_move` reach the provider the same way
 * and get the same refusal.
 */
export const moveTaskToColumn = (
  prisma: PrismaClient,
  input: Parameters<typeof moveProjectTaskToColumn>[1],
  encryptionSecret: string,
) =>
  moveProjectTaskToColumn(
    prisma,
    input,
    createBoardSourceWriteBack({ prisma, encryptionSecret }),
  )

export const updateTask = (
  prisma: PrismaClient,
  input: Parameters<typeof updateProjectTask>[1],
  encryptionSecret: string,
) =>
  updateProjectTask(prisma, input, createBoardSourceWriteBack({ prisma, encryptionSecret }))

export const createHumanTask = async (
  prisma: PrismaClient,
  input: Omit<CreateProjectTaskInput, 'assignmentAttention'>,
) => createProjectTask(prisma, { ...input, assignmentAttention: createProjectTaskAssignmentAttention })

export const assignTask = async (
  prisma: PrismaClient,
  input: Parameters<typeof assignProjectTask>[1],
  encryptionSecret: string,
) =>
  assignProjectTask(
    prisma,
    { ...input, assignmentAttention: createProjectTaskAssignmentAttention },
    createBoardSourceWriteBack({ prisma, encryptionSecret }),
  )

export const archiveDoneTasks = async (
  prisma: PrismaClient,
  input: Parameters<typeof archiveProjectDoneTasks>[1],
) => archiveProjectDoneTasks(prisma, input)
