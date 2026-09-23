import type { ExecutorCodingSessionsFacts } from '@nessie/schemas'

/**
 * What the machine's built-in coding bridge may do, read from the power facts
 * the signed descriptor carries: which coding agents, in which standing
 * permission mode, with how many pre-allowed commands, in which named
 * folders, given which environment variables, under which configuration.
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

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex' } as const

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

export const describeExecutorCodingAgents = (facts: ExecutorCodingSessionsFacts): string => {
  const agents = facts.agents.map((agent) => {
    const terms = [modeLabel(agent, facts.permissionMode[agent] ?? 'default')]
    // `allowedToolCount` counts Claude Code's `allowedTools`; Codex has none.
    if (agent === 'claude') terms.push(commandCount(facts.allowedToolCount))
    return `${AGENT_LABEL[agent]} (${terms.join(', ')})`
  })
  return `${listed(agents)} in ${listed(facts.rootNames)}`
}

export const ExecutorCodingAgents = ({ codingSessions }: ExecutorCodingAgentsProps) => {
  if (!codingSessions) return null
  return (
    <div className="mt-1 grid gap-0.5 text-[color:var(--tx2)]">
      <p>
        <span className="font-medium text-[color:var(--tx)]">Coding agents on this machine:</span>{' '}
        {describeExecutorCodingAgents(codingSessions)}
      </p>
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
