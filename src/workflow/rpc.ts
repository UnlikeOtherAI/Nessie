/**
 * src/workflow/rpc.ts — Gateway RPC handlers for workflow management.
 * Provides REST API endpoints for workflows and tasks.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { getWorkflowStore } from './store.js'
import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  CreateTaskInput,
  UpdateTaskInput,
} from './types.js'

type RpcHandler = (req: IncomingMessage, res: ServerResponse, body?: unknown) => Promise<void>


function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

// Workflow handlers
export const handleWorkflowCreate: RpcHandler = async (req, res, body) => {
  const input = body as { name?: string; description?: string; ownerAgentId?: string }
  if (!input.name) {
    return sendJson(res, 400, { error: 'name is required' })
  }
  const createInput: CreateWorkflowInput = {
    name: input.name,
    description: input.description ?? '',
    ownerAgentId: input.ownerAgentId ?? 'main',
  }
  const workflow = getWorkflowStore().createWorkflow(createInput)
  return sendJson(res, 201, { workflow })
}

export const handleWorkflowGet: RpcHandler = async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const workflowId = url.searchParams.get('workflowId')
  if (!workflowId) {
    return sendJson(res, 400, { error: 'workflowId query parameter is required' })
  }
  const workflow = getWorkflowStore().getWorkflow(workflowId)
  if (!workflow) {
    return sendJson(res, 404, { error: 'Workflow not found' })
  }
  const tasks = getWorkflowStore().listTasks(workflowId)
  return sendJson(res, 200, { workflow, tasks })
}

export const handleWorkflowList: RpcHandler = async (req, res) => {
  const workflows = getWorkflowStore().listWorkflows()
  return sendJson(res, 200, { workflows })
}

export const handleWorkflowUpdate: RpcHandler = async (req, res, body) => {
  const input = body as { workflowId?: string; name?: string; description?: string; status?: string }
  if (!input.workflowId) {
    return sendJson(res, 400, { error: 'workflowId is required' })
  }
  const updateInput: UpdateWorkflowInput = {}
  if (input.name !== undefined) updateInput.name = input.name
  if (input.description !== undefined) updateInput.description = input.description
  if (input.status !== undefined) {
    if (!['draft', 'active', 'completed', 'archived'].includes(input.status)) {
      return sendJson(res, 400, { error: 'Invalid status' })
    }
    updateInput.status = input.status as UpdateWorkflowInput['status']
  }
  const workflow = getWorkflowStore().updateWorkflow(input.workflowId, updateInput)
  if (!workflow) {
    return sendJson(res, 404, { error: 'Workflow not found' })
  }
  return sendJson(res, 200, { workflow })
}

export const handleWorkflowDelete: RpcHandler = async (req, res, body) => {
  const input = body as { workflowId?: string }
  if (!input.workflowId) {
    return sendJson(res, 400, { error: 'workflowId is required' })
  }
  const deleted = getWorkflowStore().deleteWorkflow(input.workflowId)
  return sendJson(res, 200, { deleted })
}

// Task handlers
export const handleTaskCreate: RpcHandler = async (req, res, body) => {
  const input = body as {
    workflowId?: string
    label?: string
    description?: string
    ownerAgentId?: string | null
    dependencies?: string[]
  }
  if (!input.workflowId || !input.label) {
    return sendJson(res, 400, { error: 'workflowId and label are required' })
  }
  const createInput: CreateTaskInput = {
    workflowId: input.workflowId,
    label: input.label,
    description: input.description ?? '',
    ownerAgentId: input.ownerAgentId ?? null,
    dependencies: input.dependencies ?? [],
  }
  const result = getWorkflowStore().createTask(createInput)
  if ('error' in result) {
    return sendJson(res, 400, { error: result.error })
  }
  return sendJson(res, 201, { task: result })
}

export const handleTaskGet: RpcHandler = async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const taskId = url.searchParams.get('taskId')
  if (!taskId) {
    return sendJson(res, 400, { error: 'taskId query parameter is required' })
  }
  const task = getWorkflowStore().getTask(taskId)
  if (!task) {
    return sendJson(res, 404, { error: 'Task not found' })
  }
  return sendJson(res, 200, { task })
}

export const handleTaskList: RpcHandler = async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const workflowId = url.searchParams.get('workflowId')
  if (!workflowId) {
    return sendJson(res, 400, { error: 'workflowId query parameter is required' })
  }
  const tasks = getWorkflowStore().listTasks(workflowId)
  return sendJson(res, 200, { tasks })
}

export const handleTaskUpdate: RpcHandler = async (req, res, body) => {
  const input = body as {
    taskId?: string
    label?: string
    description?: string
    status?: string
    ownerAgentId?: string | null
  }
  if (!input.taskId) {
    return sendJson(res, 400, { error: 'taskId is required' })
  }
  const updateInput: UpdateTaskInput = {}
  if (input.label !== undefined) updateInput.label = input.label
  if (input.description !== undefined) updateInput.description = input.description
  if (input.status !== undefined) {
    if (!['pending', 'in_progress', 'completed', 'failed'].includes(input.status)) {
      return sendJson(res, 400, { error: 'Invalid status' })
    }
    updateInput.status = input.status as UpdateTaskInput['status']
  }
  if (input.ownerAgentId !== undefined) updateInput.ownerAgentId = input.ownerAgentId
  const task = getWorkflowStore().updateTask(input.taskId, updateInput)
  if (!task) {
    return sendJson(res, 404, { error: 'Task not found' })
  }
  return sendJson(res, 200, { task })
}

export const handleTaskComplete: RpcHandler = async (req, res, body) => {
  const input = body as { taskId?: string; result?: string; error?: string }
  if (!input.taskId) {
    return sendJson(res, 400, { error: 'taskId is required' })
  }
  const task = getWorkflowStore().completeTask(input.taskId, input.result, input.error)
  if (!task) {
    return sendJson(res, 404, { error: 'Task not found' })
  }
  return sendJson(res, 200, { task })
}

export const handleTaskDelete: RpcHandler = async (req, res, body) => {
  const input = body as { taskId?: string }
  if (!input.taskId) {
    return sendJson(res, 400, { error: 'taskId is required' })
  }
  const deleted = getWorkflowStore().deleteTask(input.taskId)
  return sendJson(res, 200, { deleted })
}

export const handleTaskExecutable: RpcHandler = async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`)
  const workflowId = url.searchParams.get('workflowId')
  if (!workflowId) {
    return sendJson(res, 400, { error: 'workflowId query parameter is required' })
  }
  const tasks = getWorkflowStore().getExecutableTasks(workflowId)
  return sendJson(res, 200, { tasks })
}
