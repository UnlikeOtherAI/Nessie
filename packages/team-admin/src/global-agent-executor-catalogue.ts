import { formatExecutorLocalMcp, type GlobalAgentExecutorFacts } from '@nessie/executor-manage'

/**
 * How this face changes an agent, which decides whether a tool may be named.
 * Declared here rather than imported from the catalogue module, which imports
 * this one.
 */
export type GlobalAgentCatalogueWriteSurface = 'agent_tools' | 'designer_form' | 'read_only'

/**
 * The executor half of the Agent Designer's generated design catalogue.
 *
 * It is here rather than in `global-agent-catalogue.ts` because that file is
 * already at the size where a sixth subject would push it past the cap, and
 * because this one has a discipline of its own: every distinction the executor
 * standard draws — absent is not empty, unavailable carries its reason, an
 * inventory is last-observed and never live — has to survive being summarised
 * into a system prompt. Flattening one of them here would have the Designer
 * tell somebody their machine reports no MCP server when it has never reported
 * at all.
 *
 * Generated, like everything else in that block: the facts come from the same
 * entitlement-scoped reads the Executors page makes, and nothing about a
 * specific executor is ever written as prose.
 */

const bullet = (line: string): string => `- ${line}`

const indent = (text: string): string[] =>
  text.split('\n').map((line) => `    ${line}`)

/**
 * The invariant, stated where the Designer reads it.
 *
 * It is not a preference about how to word a request: the prepared change
 * literally carries no operation key, so a per-operation pick is not something
 * this agent can express. Saying so stops it promising one.
 *
 * The tool is named only by the face that holds it. Naming
 * `executor_agent_grant_prepare` inside the page sidebar — which can call no
 * tool at all — is the same defect as telling it to post a proposal card.
 */
const wholeSuiteRule = (
  writeSurface: GlobalAgentCatalogueWriteSurface,
): string[] => [
  'Giving an agent an executor is whole-suite and never a per-operation pick. '
  + (writeSurface === 'agent_tools'
    ? 'executor_agent_grant_prepare prepares ONE change covering every '
      + "operation that executor's active reviewed policy offers"
    : "One change covers every operation that executor's active reviewed "
      + 'policy offers')
  + ', minus workspace.promote, which only a person can issue. There is no way '
  + 'to grant a subset, and no agent is ever granted an executor without the '
  + 'person confirming it in Executors with fresh verification — '
  + (writeSurface === 'agent_tools'
    ? 'not itself, and not another agent.'
    : 'that confirmation happens on the Executors page, not here.'),
]

const executorLines = (executor: GlobalAgentExecutorFacts): string[] => [
  bullet(
    `${executor.label} | executorId=${executor.executorId} `
    + `| scope=${executor.scopeKind}`
    + `${executor.projectId ? ` project=${executor.projectId}` : ''} `
    + `| status=${executor.status}`,
  ),
  `    profiles=${executor.profiles.join(', ') || 'none approved yet'}`,
  `    last seen: ${executor.lastSeenAt ?? 'never'}`,
  ...(executor.statusDetail ? [`    status detail: ${executor.statusDetail}`] : []),
  ...(executor.canManage
    ? [
        ...(executor.operationKeys
          ? [
              `    active policy revision ${executor.revision} offers: `
              + `${executor.operationKeys.join(', ')}`,
            ]
          // A machine nobody has activated a policy on offers nothing yet. It
          // is a different fact from one whose policy you cannot read, and a
          // different action: somebody reviews the pending revision.
          : ['    no capability revision has been activated on it yet, so it offers nothing to grant']),
        ...indent(formatExecutorLocalMcp(executor.localMcp, executor.localMcpObservedAt)),
      ]
    // Not a redaction to apologise for: the reviewed policy and what a daemon
    // reports about its host are an administrator's read, and this person is
    // not one on this machine. Saying "unreadable" rather than staying silent
    // is what stops it being read as "reports nothing".
    : [
        '    you can reach this executor but not administer it, so its reviewed policy and '
        + 'local MCP report are not readable with your access, and you cannot grant it to an agent',
      ]),
]

export const executorSection = (
  executors: GlobalAgentExecutorFacts[] | null,
  writeSurface: GlobalAgentCatalogueWriteSurface,
): string[] => {
  if (executors === null) {
    return [
      'The executors paired to this deployment could not be read just now. Say '
      + 'so rather than guessing: never name an executor, and never tell '
      + 'somebody they have none.',
    ]
  }
  if (executors.length === 0) {
    return [
      'There is no executor you can reach in this deployment. An executor is a '
      + 'machine somebody pairs on the Executors page (/agents/executors); until '
      + 'one is paired there is nothing for an agent to run on, so send them '
      + 'there rather than designing around a machine that does not exist.',
    ]
  }
  return [
    `Executors you can reach (${executors.length}) — the paired machines an `
    + 'agent can be given work on. This is your entitlement, not the '
    + 'deployment\'s: somebody else may be able to see more.',
    ...executors.flatMap(executorLines),
    ...wholeSuiteRule(writeSurface),
  ]
}
