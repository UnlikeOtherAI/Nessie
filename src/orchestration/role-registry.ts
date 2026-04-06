import type { TaskRole } from './task-types.js'

export interface RolePolicy {
  role: TaskRole
  allowedTools: string[]
  canSpawn: boolean
  canMutateFiles: boolean
  requiresReview: boolean
}

export const ROLE_POLICIES: Record<TaskRole, RolePolicy> = {
  orchestrator: {
    role: 'orchestrator',
    allowedTools: ['Glob', 'Grep', 'FileRead'],
    canSpawn: true,
    canMutateFiles: false,
    requiresReview: false,
  },
  builder: {
    role: 'builder',
    allowedTools: ['Bash', 'FileRead', 'FileWrite', 'Glob', 'Grep', 'WebSearch'],
    canSpawn: false,
    canMutateFiles: true,
    requiresReview: true,
  },
  reviewer: {
    role: 'reviewer',
    allowedTools: ['FileRead', 'Glob', 'Grep'],
    canSpawn: false,
    canMutateFiles: false,
    requiresReview: false,
  },
  watcher: {
    role: 'watcher',
    allowedTools: ['FileRead', 'Glob', 'Grep'],
    canSpawn: false,
    canMutateFiles: false,
    requiresReview: false,
  },
  researcher: {
    role: 'researcher',
    allowedTools: ['WebSearch', 'FileRead', 'Glob', 'Grep'],
    canSpawn: false,
    canMutateFiles: false,
    requiresReview: false,
  },
  debugger: {
    role: 'debugger',
    allowedTools: ['Bash', 'FileRead', 'Glob', 'Grep'],
    canSpawn: false,
    canMutateFiles: false,
    requiresReview: true,
  },
}

export function getRolePolicy(role: TaskRole): RolePolicy {
  return ROLE_POLICIES[role]
}

export function isToolAllowed(role: TaskRole, toolName: string): boolean {
  return ROLE_POLICIES[role].allowedTools.includes(toolName)
}
