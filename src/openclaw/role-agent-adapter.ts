/**
 * src/openclaw/role-agent-adapter.ts — Converts Nessie role policies
 * to OpenClaw-compatible agent configuration format.
 *
 * OpenClaw agents have: agentId, tools (allow/deny), sandbox profile,
 * and per-agent metadata. Nessie roles map 1:1 to agent configs.
 */

import type { RolePolicy } from '../orchestration/role-registry.js'
import { ROLE_POLICIES } from '../orchestration/role-registry.js'
import type { TaskRole } from '../orchestration/task-types.js'

export interface OpenClawAgentConfig {
  agentId: string
  name: string
  tools: {
    allow: string[]
    deny: string[]
  }
  sandbox: 'permissive' | 'restrictive' | 'read-only'
  canSpawn: boolean
  requiresReview: boolean
  metadata: {
    nessieRole: TaskRole
    canMutateFiles: boolean
  }
}

function sandboxLevel(policy: RolePolicy): OpenClawAgentConfig['sandbox'] {
  if (!policy.canMutateFiles && !policy.canSpawn) return 'read-only'
  if (policy.canMutateFiles) return 'permissive'
  return 'restrictive'
}

/**
 * Convert a single Nessie RolePolicy to an OpenClaw agent config.
 */
export function toAgentConfig(policy: RolePolicy): OpenClawAgentConfig {
  return {
    agentId: `nessie-${policy.role}`,
    name: policy.role.charAt(0).toUpperCase() + policy.role.slice(1),
    tools: {
      allow: [...policy.allowedTools],
      deny: ['*'], // deny-wins: everything not in allow is denied
    },
    sandbox: sandboxLevel(policy),
    canSpawn: policy.canSpawn,
    requiresReview: policy.requiresReview,
    metadata: {
      nessieRole: policy.role,
      canMutateFiles: policy.canMutateFiles,
    },
  }
}

/**
 * Export all Nessie roles as OpenClaw agent configs.
 */
export function getAllAgentConfigs(): OpenClawAgentConfig[] {
  return (Object.values(ROLE_POLICIES) as RolePolicy[]).map(toAgentConfig)
}
