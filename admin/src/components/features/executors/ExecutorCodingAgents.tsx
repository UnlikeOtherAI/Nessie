import { EXECUTOR_CODING_MERGE_COMMANDS, type ExecutorCodingSessionsFacts } from '@nessie/schemas'

import { EXECUTOR_CODING_AGENT_LABELS } from './executor-presentation'

/**
 * What the machine's built-in coding bridge may do, read from the power facts
 * the signed descriptor carries: which coding agents, in which standing
 * permission mode, with how many pre-allowed commands and how much a turn may
 * spend, in which named folders, how many sessions each may keep open, given
 * which environment variables, under which configuration.
 *
 * It sits beside {@link ExecutorMcpServers} because a coding agent acts as the
 * machine's own user — their files, their git and SSH credentials, their
 * coding-agent login — and offering or widening that is a revision somebody
 * approves. Absent facts render nothing: the descriptor carries them exactly
 * when the machine offers the bridge. Paths, programs and values never leave
 * the host, so there is deliberately nothing more to show.
 */
export type ExecutorCodingAgentsProps = {
  codingSessions?: ExecutorCodingSessionsFacts
}

// Claude Code's `--permission-mode`; `default` means the CLI's own settings on
// that machine decide, which is what a reviewer has to read it as.
const CLAUDE_MODE_LABEL: Record<string, string> = {
  acceptEdits: 'accept edits',
  auto: 'auto mode',
  bypassPermissions: 'bypasses permissions',
  default: 'its own settings on the machine',
  dontAsk: 'denies what is not pre-allowed',
  manual: 'manual approval',
  plan: 'plan mode',
}

// The approval and sandbox stance Codex's reviewed arguments choose.
const CODEX_MODE_LABEL: Record<string, string> = {
  approveForMe: 'approves its own requests',
  bypassApprovalsAndSandbox: 'no approvals and no sandbox',
  default: 'its own settings on the machine',
  fullAuto: 'full auto',
}

const modeLabel = (agent: 'claude' | 'codex', mode: string): string => {
  if (agent === 'codex' && mode.startsWith('sandbox:')) return `sandbox ${mode.slice('sandbox:'.length)}`
  return (agent === 'claude' ? CLAUDE_MODE_LABEL : CODEX_MODE_LABEL)[mode] ?? mode
}

const listed = (names: readonly string[]): string => names.length <= 1
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

const commandCount = (count: number): string => count === 0
  ? 'no pre-allowed commands'
  : `${count} pre-allowed command${count === 1 ? '' : 's'}`

const dollars = (amount: number): string => new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  style: 'currency',
}).format(amount)

// `null` is a stated fact — nothing bounds that agent's turns — and reads so;
// an absent map is a machine too old to say, and says nothing.
const budgetTerm = (budget: number | null | undefined): string | undefined => budget === undefined
  ? undefined
  : budget === null ? 'no spending limit per turn' : `at most ${dollars(budget)} a turn`

export const describeExecutorCodingAgents = (facts: ExecutorCodingSessionsFacts): string => {
  const agents = facts.agents.map((agent) => {
    const terms = [modeLabel(agent, facts.permissionMode[agent] ?? 'default')]
    // `allowedToolCount` counts Claude Code's `allowedTools`; Codex has none.
    if (agent === 'claude') terms.push(commandCount(facts.allowedToolCount))
    const budget = budgetTerm(facts.maxBudgetUsd?.[agent])
    if (budget) terms.push(budget)
    return `${EXECUTOR_CODING_AGENT_LABELS[agent]} (${terms.join(', ')})`
  })
  return `${listed(agents)} in ${listed(facts.rootNames)}`
}

/** The live-session quota in words, or nothing for a machine too old to state it. */
export const describeExecutorCodingSessionQuota = (facts: ExecutorCodingSessionsFacts): string | undefined => {
  const most = facts.maxLiveSessionsPerOwner
  if (most === undefined) return undefined
  return `Each agent may keep ${most === 1 ? 'one session' : `up to ${most} sessions`} open at once for the `
    + 'person it works for.'
}

/**
 * Whether a ticket on this machine can reach a merge on its own, from the
 * signed `mergeCommands` fact, or nothing for a machine too old to state it.
 */
export const describeExecutorCodingMerge = (facts: ExecutorCodingSessionsFacts): string | undefined => {
  const allowed = facts.mergeCommands
  if (allowed === undefined || !facts.agents.includes('claude')) return undefined
  const missing = EXECUTOR_CODING_MERGE_COMMANDS.filter((command) => !allowed.includes(command))
  return missing.length === 0
    ? 'Claude Code may push, open, watch and merge pull requests without asking.'
    : `Claude Code must ask before ${listed(missing)}, so work here stops at an open pull request.`
}

export const ExecutorCodingAgents = ({ codingSessions }: ExecutorCodingAgentsProps) => {
  if (!codingSessions) return null
  const quota = describeExecutorCodingSessionQuota(codingSessions)
  const merge = describeExecutorCodingMerge(codingSessions)
  return (
    <div className="mt-1 grid gap-0.5 text-[color:var(--tx2)]">
      <p>
        <span className="font-medium text-[color:var(--tx)]">Coding agents on this machine:</span>{' '}
        {describeExecutorCodingAgents(codingSessions)}
      </p>
      {quota ? <p>{quota}</p> : null}
      {merge ? <p>{merge}</p> : null}
      {codingSessions.environmentNames.length > 0 ? (
        <p>Given the variables {listed(codingSessions.environmentNames)}.</p>
      ) : null}
      <p className="text-[color:var(--tx3)]">
        They work as this machine’s user, with its files and logins. Configuration{' '}
        <span className="font-mono" title={codingSessions.configDigest}>
          {codingSessions.configDigest.slice(0, 'sha256:'.length + 12)}…
        </span>
      </p>
    </div>
  )
}
