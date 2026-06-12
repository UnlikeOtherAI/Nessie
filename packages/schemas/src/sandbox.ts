import { z } from 'zod'

// ─── Sandbox Configuration ───────────────────────────────────────────────────

/**
 * Sandbox mode determines where exec commands run:
 * - 'off': sandbox disabled, exec runs directly on host (auto → gateway)
 * - 'non-main': sandbox only for non-main agents (auto → sandbox for non-main)
 * - 'all': sandbox for all agents (auto → sandbox)
 */
export const SandboxModeSchema = z.enum(['off', 'non-main', 'all'])
export type SandboxMode = z.infer<typeof SandboxModeSchema>

export const SandboxConfigSchema = z.object({
  mode: SandboxModeSchema.default('off'),
  docker: z.object({
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    workdir: z.string().optional(),
    readOnlyRoot: z.boolean().optional(),
    tmpfs: z.array(z.string()).optional(),
    network: z.string().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    cpus: z.union([z.string(), z.number()]).optional(),
    binds: z.array(z.string()).optional(),
  }).optional(),
  workspaceAccess: z.enum(['none', 'ro', 'rw']).optional(),
  scope: z.enum(['session', 'agent', 'shared']).optional(),
  workspaceRoot: z.string().optional(),
})
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>

/**
 * Exec host target for tool execution.
 * - 'auto': resolves to 'gateway', 'sandbox', or 'node' based on sandbox availability
 * - 'gateway': always run exec on the gateway (host)
 * - 'sandbox': always run exec in sandbox
 * - 'node': run exec on a specific node
 */
export const ExecHostSchema = z.enum(['auto', 'gateway', 'sandbox', 'node'])
export type ExecHost = z.infer<typeof ExecHostSchema>

export const ExecToolsConfigSchema = z.object({
  host: ExecHostSchema.default('auto'),
  security: z.enum(['deny', 'allowlist', 'full']).optional(),
  ask: z.enum(['off', 'on-miss', 'always']).optional(),
  safeBins: z.array(z.string()).optional(),
  timeoutSec: z.number().int().positive().optional(),
  cleanupMs: z.number().int().nonnegative().optional(),
  backgroundMs: z.number().int().nonnegative().optional(),
})
export type ExecToolsConfig = z.infer<typeof ExecToolsConfigSchema>

// ─── Agent Tool Policy with Sandbox ──────────────────────────────────────────

export const AgentToolPolicySchema = z.object({
  profile: z.enum(['minimal', 'coding', 'messaging', 'full']).optional(),
  allow: z.array(z.string()).optional(),
  alsoAllow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
  exec: ExecToolsConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
})
export type AgentToolPolicy = z.infer<typeof AgentToolPolicySchema>
