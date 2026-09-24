import type { PrismaClient } from '@prisma/client'
import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import type { RunExecuteJobPayload } from '@nessie/schemas'

import { BUILTIN_TOOL_SPEC_NAME } from '../builtin-toolset-deferred.js'
import { launchConversationScope } from '../executor-host-output.js'
import { buildInlineView } from '../mcp-toolset-deferred.js'
import type { McpToolset } from '../mcp-toolset.js'
import { summarizeToolInput } from '../tool-util.js'
import { bindTicketWorkMachine, loadTicketWorkRunFacts, type TicketWorkRunFacts } from './ticket-work-setup.js'
import type { RunContext } from './types.js'

/**
 * What a `ticket.work` run that can reach its author's machine may send out of
 * Nessie (docs/standards/ticket-work-machine-access.md → "Disclosure"): nothing.
 * A run is **standing** when its standing policy bound it a machine this turn,
 * or when its record has ever held a coding session — its kickoff, its thread
 * and its pull request already carry what that machine answered. A standing
 * run is not offered, and is refused at `authorizeToolExecution`, every tool
 * that reaches past Nessie or hands the conversation to another model: the
 * web and HTTP tools, the browser, every MCP connector tool, and the delegate
 * and sub-agent tools. What the machine answered then leaves only through the
 * ticket's own comments and its work thread (`ticketWorkHostOutputRefusal`).
 *
 * A record that has held a session is stamped with host output at setup, so
 * the output rules hold from its first tool call, before any tool has read the
 * machine again this turn.
 */

export type TicketWorkScope = { standing: boolean; taskId: string }

/** Withheld from, and refused on, a standing run. MCP tools are withheld as a toolset (`withoutMcpTools`). */
export const TICKET_WORK_STANDING_WITHHELD_TOOL_IDS: ReadonlySet<string> = new Set([
  'http_fetch', 'web_fetch', 'web_search',
  'browser_open', 'browser_observe', 'browser_act', 'browser_download', 'browser_login_request',
  'dashboard_source_probe',
  'delegate', 'spawn_subtask', 'agent_peer_delegate',
])

export const TICKET_WORK_STANDING_REFUSAL = 'This ticket\'s work can reach its owner\'s machine, so it cannot reach '
  + 'the web, a connector or another agent: work from the ticket, the machine and the coding session.'

export const TICKET_WORK_OWN_TICKET_REFUSAL = 'This run has read the machine\'s output, so it may comment on, move '
  + 'or transition only its own ticket.'

/** The writes that name a ticket, admitted after host output only for the run's own. */
const OWN_TICKET_TOOL_IDS: ReadonlySet<string> = new Set(['ticket_comment_add', 'ticket_move', 'ticket_transition'])

const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.id))

/**
 * A `ticket.work` run's facts, read and bound at the start of setup, before
 * any tool is resolved: its record, its machine (`bindTicketWorkMachine`) and
 * whether it is standing. Null for every other run.
 */
export const prepareTicketWorkRun = async (
  prisma: PrismaClient,
  input: { context: RunContext; payload: RunExecuteJobPayload },
): Promise<TicketWorkRunFacts | null> => {
  const { context, payload } = input
  const ticketWork = await loadTicketWorkRunFacts(prisma, {
    actorContext: payload.actorContext,
    agentId: context.agent.id,
    threadId: context.run.threadId,
  })
  if (!ticketWork) return null
  context.ticketWorkMachine = await bindTicketWorkMachine(prisma, {
    job: payload, runId: context.run.id, workId: ticketWork.workId,
  })
  const kind = context.ticketWorkMachine?.binding.kind
  context.ticketWorkScope = {
    standing: kind === 'bound' || kind === 'already_bound' || ticketWork.heldSessions,
    taskId: ticketWork.taskId,
  }
  if (ticketWork.heldSessions) context.consumedSources.addHostOutputScope(launchConversationScope(context.channel.id))
  return ticketWork
}

/** A standing run's MCP toolset: no connector tool at all, and a dispatch that refuses. */
export const withoutMcpTools = (): McpToolset => {
  const dispatch: McpToolset['dispatch'] = async (_exposedName, args) => ({
    inputSummary: summarizeToolInput(args), output: TICKET_WORK_STANDING_REFUSAL, success: false,
  })
  return {
    createView: () => buildInlineView([], dispatch),
    dispatch,
    entries: [],
    managedResearchToolNames: new Set(),
    mode: 'inline',
    timeoutErrorFor: () => null,
  }
}

/**
 * Why `authorizeToolExecution` refuses a tool on a `ticket.work` run, or null:
 * after host output, a ticket write that names another ticket; on a standing
 * run, a withheld tool and any name that is neither a builtin nor one of the
 * run's executor tools — an MCP connector tool, whatever view offered it.
 */
export const ticketWorkStandingRefusal = (input: {
  args: Record<string, unknown>
  context: Pick<RunContext, 'consumedSources' | 'ticketWorkScope'>
  executorToolNames?: ReadonlySet<string>
  toolName: string
}): string | null => {
  const scope = input.context.ticketWorkScope
  if (!scope) return null
  const { toolName } = input
  if (OWN_TICKET_TOOL_IDS.has(toolName) && input.context.consumedSources.hostOutputScopes().length > 0
    && String(input.args.ticketId ?? '').toLowerCase() !== scope.taskId.toLowerCase()) {
    return TICKET_WORK_OWN_TICKET_REFUSAL
  }
  if (!scope.standing) return null
  if (TICKET_WORK_STANDING_WITHHELD_TOOL_IDS.has(toolName)) return TICKET_WORK_STANDING_REFUSAL
  const known = BUILTIN_IDS.has(toolName) || toolName === BUILTIN_TOOL_SPEC_NAME
    || (input.executorToolNames?.has(toolName) ?? false)
  return known ? null : TICKET_WORK_STANDING_REFUSAL
}
