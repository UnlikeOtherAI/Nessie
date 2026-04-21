/**
 * src/workflow/tool.ts — Agent tool for interacting with workflows.
 * Provides programmatic access to workflow management.
 */

import { z } from 'zod'
import { buildTool } from '../tools/Tool.js'
import type { Tool } from '../tools/Tool.js'
import {
  getWorkflowStore,
  WorkflowStoreManager,
} from './store.js'
import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  CreateTaskInput,
  UpdateTaskInput,
} from './types.js'

// Schema for creating a workflow
const CreateWorkflowToolSchema = z.object({
  action: z.literal('create'),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  ownerAgentId: z.string().optional().default('main'),
})

// Schema for getting a workflow
const GetWorkflowToolSchema = z.object({
  action: z.literal('get'),
  workflowId: z.string().uuid(),
})

// Schema for listing workflows
const ListWorkflowsToolSchema = z.object({
  action: z.literal('list'),
})

// Schema for updating a workflow
const UpdateWorkflowToolSchema = z.object({
  action: z.literal('update'),
  workflowId: z.string().uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
})

// Schema for deleting a workflow
const DeleteWorkflowToolSchema = z.object({
  action: z.literal('delete'),
  workflowId: z.string().uuid(),
})

// Schema for creating a task
const CreateTaskToolSchema = z.object({
  action: z.literal('createTask'),
  workflowId: z.string().uuid(),
  label: z.string().min(1),
  description: z.string().optional().default(''),
  ownerAgentId: z.string().nullable().optional(),
  dependencies: z.array(z.string().uuid()).default([]),
})

// Schema for getting a task
const GetTaskToolSchema = z.object({
  action: z.literal('getTask'),
  taskId: z.string().uuid(),
})

// Schema for listing tasks in a workflow
const ListTasksToolSchema = z.object({
  action: z.literal('listTasks'),
  workflowId: z.string().uuid(),
})

// Schema for updating a task
const UpdateTaskToolSchema = z.object({
  action: z.literal('updateTask'),
  taskId: z.string().uuid(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).optional(),
  ownerAgentId: z.string().nullable().optional(),
})

// Schema for completing a task
const CompleteTaskToolSchema = z.object({
  action: z.literal('completeTask'),
  taskId: z.string().uuid(),
  result: z.string().optional(),
  error: z.string().optional(),
})

// Schema for deleting a task
const DeleteTaskToolSchema = z.object({
  action: z.literal('deleteTask'),
  taskId: z.string().uuid(),
})

// Schema for getting executable tasks (ready to run)
const GetExecutableTasksToolSchema = z.object({
  action: z.literal('getExecutableTasks'),
  workflowId: z.string().uuid(),
})

// Union schema for all workflow operations
const WorkflowToolSchema = z.discriminatedUnion('action', [
  CreateWorkflowToolSchema,
  GetWorkflowToolSchema,
  ListWorkflowsToolSchema,
  UpdateWorkflowToolSchema,
  DeleteWorkflowToolSchema,
  CreateTaskToolSchema,
  GetTaskToolSchema,
  ListTasksToolSchema,
  UpdateTaskToolSchema,
  CompleteTaskToolSchema,
  DeleteTaskToolSchema,
  GetExecutableTasksToolSchema,
])

export type WorkflowToolInput = z.infer<typeof WorkflowToolSchema>

export function createWorkflowTool(store?: WorkflowStoreManager): Tool<Record<string, unknown>, unknown> {
  const workflowStore = store ?? getWorkflowStore()

  return buildTool({
    name: 'Workflow',
    description: 'Manage workflows and tasks for complex multi-step operations with DAG visualization support',
    inputSchema: WorkflowToolSchema,

    async call(args, _context) {
      switch (args.action) {
        case 'create': {
          const input: CreateWorkflowInput = {
            name: args.name,
            description: args.description ?? '',
            ownerAgentId: args.ownerAgentId ?? 'main',
          }
          const workflow = workflowStore.createWorkflow(input)
          return { data: { workflow } } as { data: unknown }
        }

        case 'get': {
          const workflow = workflowStore.getWorkflow(args.workflowId)
          if (!workflow) {
            return { data: { error: `Workflow not found: ${args.workflowId}` } } as { data: unknown }
          }
          const tasks = workflowStore.listTasks(args.workflowId)
          return { data: { workflow, tasks } } as { data: unknown }
        }

        case 'list': {
          const workflows = workflowStore.listWorkflows()
          return { data: { workflows } } as { data: unknown }
        }

        case 'update': {
          const input: UpdateWorkflowInput = {}
          if (args.name !== undefined) input.name = args.name
          if (args.description !== undefined) input.description = args.description
          if (args.status !== undefined) input.status = args.status
          const workflow = workflowStore.updateWorkflow(args.workflowId, input)
          if (!workflow) {
            return { data: { error: `Workflow not found: ${args.workflowId}` } } as { data: unknown }
          }
          return { data: { workflow } } as { data: unknown }
        }

        case 'delete': {
          const deleted = workflowStore.deleteWorkflow(args.workflowId)
          return { data: { deleted } } as { data: unknown }
        }

        case 'createTask': {
          const input: CreateTaskInput = {
            workflowId: args.workflowId,
            label: args.label,
            description: args.description ?? '',
            ownerAgentId: args.ownerAgentId ?? null,
            dependencies: args.dependencies ?? [],
          }
          const result = workflowStore.createTask(input)
          if ('error' in result) {
            return { data: { error: result.error } } as { data: unknown }
          }
          return { data: { task: result } } as { data: unknown }
        }

        case 'getTask': {
          const task = workflowStore.getTask(args.taskId)
          if (!task) {
            return { data: { error: `Task not found: ${args.taskId}` } } as { data: unknown }
          }
          return { data: { task } } as { data: unknown }
        }

        case 'listTasks': {
          const tasks = workflowStore.listTasks(args.workflowId)
          return { data: { tasks } } as { data: unknown }
        }

        case 'updateTask': {
          const input: UpdateTaskInput = {}
          if (args.label !== undefined) input.label = args.label
          if (args.description !== undefined) input.description = args.description
          if (args.status !== undefined) input.status = args.status
          if (args.ownerAgentId !== undefined) input.ownerAgentId = args.ownerAgentId
          const task = workflowStore.updateTask(args.taskId, input)
          if (!task) {
            return { data: { error: `Task not found: ${args.taskId}` } } as { data: unknown }
          }
          return { data: { task } } as { data: unknown }
        }

        case 'completeTask': {
          const task = workflowStore.completeTask(args.taskId, args.result, args.error)
          if (!task) {
            return { data: { error: `Task not found: ${args.taskId}` } } as { data: unknown }
          }
          return { data: { task } } as { data: unknown }
        }

        case 'deleteTask': {
          const deleted = workflowStore.deleteTask(args.taskId)
          return { data: { deleted } } as { data: unknown }
        }

        case 'getExecutableTasks': {
          const tasks = workflowStore.getExecutableTasks(args.workflowId)
          return { data: { tasks } } as { data: unknown }
        }

        default:
          return { data: { error: `Unknown action: ${(args as { action: string }).action}` } } as { data: unknown }
      }
    },

    isConcurrencySafe() { return false },
    isReadOnly() { return false },

    userFacingName() { return 'Workflow' },
    getActivityDescription(input) {
      const desc = (input && 'description' in input) ? input.description : undefined
      return desc ?? `Workflow: ${String((input as { action?: string })?.action ?? 'operation')}`
    },
    maxResultSizeChars: 50_000,
  })
}

export const WorkflowTool = createWorkflowTool()
