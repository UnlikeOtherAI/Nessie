import type { PrismaClient } from '@prisma/client'
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
  setProjectTaskIteration,
  transitionProjectTask,
  updateProjectTask,
  type CreateProjectTaskInput,
  type ProjectTaskUpdateFields,
  type ProjectTaskVisibility,
} from '@nessie/team-admin'

// These route-facing names keep their established API while the work itself is
// shared with the personal assistant in @nessie/team-admin.
export type TaskVisibility = ProjectTaskVisibility
export type TaskUpdateFields = ProjectTaskUpdateFields

export const taskVisibilityWhere = projectTaskVisibilityWhere
export const listTasks = listProjectTasks
export const getTask = getProjectTask
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
