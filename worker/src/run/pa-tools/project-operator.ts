import { BUILTIN_TOOL_DEFINITIONS } from '@nessie/runtime'
import { canModifyProject } from '@nessie/team-admin'

import {
  loadProjectOperatorFacts,
  PROJECT_OPERATOR_LIVE_TURN_REFUSAL,
  projectOperatorRefusal,
} from '../project-operator-admission.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { requireActingUserId, resolveActingMember, type ActingMember } from './access.js'

/**
 * The handlers' half of the project-operator arm: every condition the run was
 * admitted on, re-read from live rows at the moment of the call
 * (`../project-operator-admission.ts` holds the other half). A verb that
 * reaches here on the operator face acts as the person asking, through the
 * same service function its route calls, and is refused where they would be.
 */

/**
 * Which arm a call can have come through, read from the call's own structural
 * facts — never a flag something upstream set. The Personal Assistant has its
 * own arm; a global agent's identity arm opens only in its own home DM, a
 * `system_agent` conversation; every other agent can only be here on the
 * operator arm, whatever the surface, and is held to all of its conditions.
 */
export type ActingFace = 'global_agent' | 'personal_assistant' | 'project_operator'

export const actingFaceOf = (
  context: Pick<BuiltinToolRuntimeContext, 'agentKind' | 'channel' | 'runContext'>,
): ActingFace => {
  if (context.agentKind === 'personal_assistant') return 'personal_assistant'
  // The run's own agent row says whether this is a global agent at all; only
  // a context built without one (a fixture) falls back to the surface alone.
  const globalAgent = context.runContext ? Boolean(context.runContext.agent.systemSlug) : true
  return context.channel.systemChannelType === 'system_agent' && globalAgent ? 'global_agent' : 'project_operator'
}

/** The verbs that run only on a live person's own turn (`requiresLiveRequester`). */
const LIVE_REQUESTER_TOOL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.requiresLiveRequester === true).map((tool) => tool.id),
)

const REFUSAL =
  'This sets things up for the person talking to you, so it works only in a project channel you are '
  + 'in, and only while your owner has given you the project-operator grant. It cannot run here.'

/**
 * Re-checks the whole arm and answers the project of this channel: the same
 * facts and the same verdict run setup admitted the arm on
 * (`loadProjectOperatorFacts`, `projectOperatorRefusal`), read again from
 * live rows at the moment of the call — the agent, the room, its project, the
 * binding, the grant, the organisation's switch, the run row, and the
 * person's own messages its turn names.
 */
export const assertProjectOperatorCall = async (
  context: BuiltinToolRuntimeContext,
): Promise<{ projectId: string }> => {
  // A run with nobody to act as says so first, in its own words: ticket work
  // acts as the agent (docs/standards/ticket-work.md), a fire as no one.
  requireActingUserId(context)
  const facts = await loadProjectOperatorFacts(context.prisma, {
    actorId: context.actorContext.actor.actorId,
    actorType: context.actorContext.actor.actorType,
    agentId: context.agentId,
    batchMessageIds: context.run.batchMessageIds ?? null,
    channelId: context.channel.id,
    effectiveUserId: context.actorContext.actionContext.effectiveUserId ?? null,
    interactive: context.run.interactive === true,
    messageId: context.run.messageId,
    organizationId: context.channel.organizationId,
    purpose: context.actorContext.actionContext.purpose ?? null,
    resumedByUserId: context.run.resumedByUserId ?? null,
    runId: context.run.id,
    threadId: context.run.threadId,
  })
  const refusal = projectOperatorRefusal(facts)
  if (refusal === 'not_a_live_turn' || refusal === 'not_the_persons_own_turn') {
    throw new Error(PROJECT_OPERATOR_LIVE_TURN_REFUSAL)
  }
  if (refusal !== null || !facts.channel) throw new Error(REFUSAL)
  return { projectId: facts.channel.projectId }
}

/**
 * The acting member for a verb that more than one arm reaches. On the
 * operator face the whole arm is re-checked first; on the Personal
 * Assistant's and a global agent's the call arrived through their own arm,
 * whose conditions its toolset and per-call gate already held. `projectId`
 * is this channel's project on the operator face, null elsewhere.
 */
export const resolveOperatorAwareMember = async (
  context: BuiltinToolRuntimeContext,
  /** The verb being called: a `requiresLiveRequester` one needs a live turn on every face. */
  toolId?: string,
): Promise<{ face: ActingFace; member: ActingMember; operatorProjectId: string | null }> => {
  const face = actingFaceOf(context)
  // The operator face re-checks the live turn below; the Personal Assistant's
  // arm also opens on the schedules it fires for its owner, so it is re-checked
  // here for the verbs that must never run as somebody who is not there.
  if (
    face !== 'project_operator' && toolId !== undefined && LIVE_REQUESTER_TOOL_IDS.has(toolId)
    && (context.run.interactive !== true || context.actorContext.actor.actorType !== 'user')
  ) {
    throw new Error(PROJECT_OPERATOR_LIVE_TURN_REFUSAL)
  }
  const operator = face === 'project_operator' ? await assertProjectOperatorCall(context) : null
  return { face, member: await resolveActingMember(context), operatorProjectId: operator?.projectId ?? null }
}

/**
 * A project the person asking may change (`canModifyProject`, the gate every
 * project-structure route takes: a member of the project, or an organisation
 * owner or admin), refused in words when they may not. Named explicitly, or on
 * the operator face this channel's project.
 */
export const requireModifiableProject = async (
  context: BuiltinToolRuntimeContext,
  member: ActingMember,
  projectId: string,
): Promise<void> => {
  if (!(await canModifyProject(context.prisma, member, projectId))) {
    throw new Error(
      'The person you are acting for cannot change that project: only its members, or an organisation '
      + 'owner or admin, can. Resolve a project they are in with project_list.',
    )
  }
}

/**
 * For a project board tool the lend reaches too (`ticket_board_create`,
 * `ticket_label_create`): the operator's member and project when this call is
 * the operator's — a shared agent in a project room naming another project, or
 * holding no lend of this tool — and null when it is the lend's, which keeps
 * its own path (the requester, the binding, the channel's project).
 */
export const resolveOperatorProjectCall = async (
  context: BuiltinToolRuntimeContext,
  toolId: string,
  named: string | undefined,
): Promise<{ member: ActingMember; projectId: string } | null> => {
  if (actingFaceOf(context) !== 'project_operator') return null
  const elsewhere = named !== undefined && named !== context.channel.projectId
  if (!elsewhere && (await isLentProjectTool(context, toolId))) return null
  const { projectId: here } = await assertProjectOperatorCall(context)
  const member = await resolveActingMember(context)
  const projectId = named ?? here
  await requireModifiableProject(context, member, projectId)
  return { member, projectId }
}

/**
 * Whether a project board tool reaches this call on its own lend — the policy
 * allow `resolveProjectDelegatedToolIds` reads — rather than on the operator
 * arm. The lend keeps its own checks (the requester, the binding, the
 * channel's project); a call the lend does not cover is the operator's, and
 * re-checks the whole arm.
 */
export const isLentProjectTool = async (
  context: BuiltinToolRuntimeContext,
  toolId: string,
): Promise<boolean> => {
  const agent = await context.prisma.agent.findUnique({
    where: { id: context.agentId },
    select: { toolPolicy: true },
  })
  const policy = agent?.toolPolicy && typeof agent.toolPolicy === 'object'
    ? agent.toolPolicy as Record<string, unknown>
    : {}
  return policy[toolId] === true
}
