import { PROJECT_OPERATOR_CAPABILITY_ID } from '@nessie/runtime'
import { canModifyProject } from '@nessie/team-admin'

import {
  isLiveRequesterRun,
  isProjectOperatorCapabilityEnabled,
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
  context: Pick<BuiltinToolRuntimeContext, 'agentKind' | 'channel'>,
): ActingFace =>
  context.agentKind === 'personal_assistant'
    ? 'personal_assistant'
    : context.channel.systemChannelType === 'system_agent' ? 'global_agent' : 'project_operator'

const REFUSAL =
  'This sets things up for the person talking to you, so it works only on their own turn in a '
  + 'project channel you are in, and only while your owner has given you the project-operator '
  + 'grant. It cannot run here.'

/**
 * Re-checks the whole arm and answers the project of this channel: a live
 * ordinary shared agent that is nobody's child, still bound to a live ordinary
 * channel of a live project, still holding `project_operator` in an
 * organisation that has not switched it off, on a person's own interactive
 * turn with no other identity or purpose riding on it.
 */
export const assertProjectOperatorCall = async (
  context: BuiltinToolRuntimeContext,
): Promise<{ projectId: string }> => {
  // A run with nobody to act as says so first, in its own words: ticket work
  // acts as the agent (docs/standards/ticket-work.md), a fire as no one.
  requireActingUserId(context)
  const organizationId = context.channel.organizationId
  const [agent, channel, bindings, capabilityEnabled] = await Promise.all([
    context.prisma.agent.findFirst({
      where: { deletedAt: null, id: context.agentId, organizationId },
      select: { agentKind: true, parentAgentId: true, systemManaged: true, systemSlug: true, toolPolicy: true },
    }),
    context.prisma.channel.findFirst({
      where: {
        archivedAt: null, deletedAt: null, id: context.channel.id, organizationId, project: { deletedAt: null },
      },
      select: { dmKey: true, projectId: true, systemChannelType: true, type: true },
    }),
    context.prisma.agentBinding.count({ where: { agentId: context.agentId, channelId: context.channel.id } }),
    isProjectOperatorCapabilityEnabled(context.prisma, organizationId),
  ])
  const policy = agent?.toolPolicy && typeof agent.toolPolicy === 'object'
    ? agent.toolPolicy as Record<string, unknown>
    : {}
  const admitted = agent !== null
    && channel !== null
    && channel.type === 'standard'
    && bindings > 0
    && capabilityEnabled
    && policy[PROJECT_OPERATOR_CAPABILITY_ID] === true
    && isLiveRequesterRun({
      actorId: context.actorContext.actor.actorId,
      actorType: context.actorContext.actor.actorType,
      agentKind: agent.agentKind,
      channel: { dmKey: channel.dmKey, systemChannelType: channel.systemChannelType },
      effectiveUserId: context.actorContext.actionContext.effectiveUserId,
      interactive: context.run.interactive === true,
      parentAgentId: agent.parentAgentId,
      purpose: context.actorContext.actionContext.purpose,
      systemManaged: agent.systemManaged,
      systemSlug: agent.systemSlug,
    })
  if (!admitted) throw new Error(REFUSAL)
  return { projectId: channel.projectId }
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
): Promise<{ face: ActingFace; member: ActingMember; operatorProjectId: string | null }> => {
  const face = actingFaceOf(context)
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
