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
import type { SandboxConfig } from '../../packages/schemas/dist/index.js'

export interface OpenClawAgentConfig {
  agentId: string
  name: string
  tools: {
    allow: string[]
    deny: string[]
  }
  sandbox: 'permissive' | 'restrictive' | 'read-only'
  /**
   * Sandbox configuration for exec host resolution.
   * When set, controls whether exec commands run in a sandbox.
   */
  sandboxConfig?: SandboxConfig
  /**
   * Effective exec host for this agent, resolved from tools.exec.host
   * and sandbox availability.
   * - 'auto': resolved at runtime based on sandbox availability
   * - 'gateway': run exec directly on the gateway/host
   * - 'sandbox': run exec in sandbox
   * - 'node': run exec on a specific node
   */
  execHost: 'auto' | 'gateway' | 'sandbox' | 'node'
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
 * Check if sandbox is available for exec routing.
 *
 * SECURITY FIX (openclaw/openclaw#67468):
 * Before: Boolean(defaults?.sandbox) — truthy for ANY sandbox config object, even {mode: 'off'}
 * After:  Boolean(defaults?.sandbox?.mode && defaults.sandbox.mode !== 'off')
 *
 * This ensures that when sandbox mode is explicitly set to 'off',
 * exec.host='auto' resolves to 'gateway' (host) instead of incorrectly
 * routing to sandbox.
 *
 * Edge cases handled:
 * - Empty sandbox config {}: mode undefined → sandbox unavailable (safe default)
 * - Partial config {docker: {image: 'x'}}: mode undefined → unavailable
 * - Explicit mode: 'off' → unavailable
 * - Explicit mode: 'non-main' or 'all' → available
 */
export function isSandboxAvailable(sandboxConfig?: SandboxConfig): boolean {
  return Boolean(sandboxConfig?.mode && sandboxConfig.mode !== 'off')
}

/**
 * Resolve the effective exec host from the exec.host setting and sandbox availability.
 *
 * When exec.host is 'auto':
 * - If sandbox is available → resolve to 'sandbox'
 * - Otherwise → resolve to 'gateway' (host)
 *
 * Explicit exec.host values ('gateway', 'sandbox', 'node') are always respected
 * regardless of sandbox availability.
 */
export function resolveExecHost(
  execHost: 'auto' | 'gateway' | 'sandbox' | 'node',
  sandboxConfig?: SandboxConfig,
): 'gateway' | 'sandbox' | 'node' {
  if (execHost !== 'auto') {
    return execHost
  }
  return isSandboxAvailable(sandboxConfig) ? 'sandbox' : 'gateway'
}

/**
 * Convert a single Nessie RolePolicy to an OpenClaw agent config.
 *
 * @param policy - The Nessie role policy to convert
 * @param sandboxConfig - Optional sandbox configuration controlling exec host resolution
 * @param execHost - The exec host setting (default: 'auto')
 */
export function toAgentConfig(
  policy: RolePolicy,
  sandboxConfig?: SandboxConfig,
  execHost: 'auto' | 'gateway' | 'sandbox' | 'node' = 'auto',
): OpenClawAgentConfig {
  return {
    agentId: `nessie-${policy.role}`,
    name: policy.role.charAt(0).toUpperCase() + policy.role.slice(1),
    tools: {
      allow: [...policy.allowedTools],
      deny: ['*'], // deny-wins: everything not in allow is denied
    },
    sandbox: sandboxLevel(policy),
    sandboxConfig,
    execHost: resolveExecHost(execHost, sandboxConfig),
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
 *
 * @param sandboxConfig - Optional sandbox configuration to apply to all agents
 * @param execHost - The exec host setting (default: 'auto')
 */
export function getAllAgentConfigs(
  sandboxConfig?: SandboxConfig,
  execHost: 'auto' | 'gateway' | 'sandbox' | 'node' = 'auto',
): OpenClawAgentConfig[] {
  return (Object.values(ROLE_POLICIES) as RolePolicy[]).map(
    (policy) => toAgentConfig(policy, sandboxConfig, execHost),
  )
}
