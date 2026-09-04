import type { PrismaClient } from '@prisma/client'
import {
  archiveProjectDoneTasks,
  assignProjectTask,
  createProjectTask,
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
export const moveTaskToColumn = moveProjectTaskToColumn
export const isValidTransition = isProjectTaskTransitionValid
export const setTaskIteration = setProjectTaskIteration
export const updateTask = updateProjectTask
export const transitionTask = transitionProjectTask

export const createHumanTask = async (
  prisma: PrismaClient,
  input: Omit<CreateProjectTaskInput, 'assignmentAttention'>,
) => createProjectTask(prisma, { ...input, assignmentAttention: createProjectTaskAssignmentAttention })

export const assignTask = async (
  prisma: PrismaClient,
  input: Parameters<typeof assignProjectTask>[1],
) => assignProjectTask(prisma, { ...input, assignmentAttention: createProjectTaskAssignmentAttention })

export const archiveDoneTasks = async (
  prisma: PrismaClient,
  input: Parameters<typeof archiveProjectDoneTasks>[1],
) => archiveProjectDoneTasks(prisma, input)
