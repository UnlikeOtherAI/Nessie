import {
  ExecutorCommandAllowlistSchema,
  ExecutorCommandRunArgumentsSchema,
  executorCommandAllowlistPermits,
  formatExecutorCommandPattern,
  parseExecutorCommandPattern,
} from '@nessie/schemas'

/** Machine-owned rules. These never enter a descriptor or a server response. */
export type LocalCommandPolicy = {
  mode: 'all' | 'allowlist'
  allowlist: string[]
  denylist: string[]
}

export const newLocalCommandPolicy = (): LocalCommandPolicy => ({ mode: 'all', allowlist: [], denylist: [] })

export const parseLocalCommandPolicy = (value: unknown): LocalCommandPolicy => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local command policy.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'allowlist,denylist,mode'
    || !['all', 'allowlist'].includes(String(input.mode))) throw new Error('Invalid local command policy.')
  const rules = (entries: unknown): string[] => {
    const parsed = ExecutorCommandAllowlistSchema.safeParse(entries)
    if (!parsed.success) throw new Error('Use command rules such as "git *" or "npm run *", one per line.')
    const normalized = parsed.data.map((entry) => formatExecutorCommandPattern(parseExecutorCommandPattern(entry)!))
    if (new Set(normalized).size !== normalized.length) throw new Error('List each command rule once.')
    return normalized.sort()
  }
  return { mode: input.mode as LocalCommandPolicy['mode'], allowlist: rules(input.allowlist), denylist: rules(input.denylist) }
}

type CommandPolicyState = { commandPolicy?: LocalCommandPolicy; descriptor: { commandAllowlist?: string[] } }

/** Old connections retain their exact allowlist until the owner changes it locally. */
export const localCommandPolicyOf = (state: CommandPolicyState): LocalCommandPolicy => state.commandPolicy
  ? parseLocalCommandPolicy(state.commandPolicy)
  : { mode: 'allowlist', allowlist: [...(state.descriptor.commandAllowlist ?? [])], denylist: [] }

export const localCommandPolicyPermits = (state: CommandPolicyState, program: string, args: string[]): boolean => {
  if (!ExecutorCommandRunArgumentsSchema.safeParse({ program, args }).success) return false
  const policy = localCommandPolicyOf(state)
  if (executorCommandAllowlistPermits(policy.denylist, program, args)) return false
  return policy.mode === 'all' || executorCommandAllowlistPermits(policy.allowlist, program, args)
}
