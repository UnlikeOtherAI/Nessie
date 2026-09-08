import { useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { useUpdateAgent } from '../../../facades/agents/hooks'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { AgentVisibilityPill } from '../../shared/AgentVisibilityPill'
import {
  agentOwnershipState,
  canChangeAgentOwner,
  useAgentEditViewer,
  type AgentEditViewer,
} from './agent-edit-authority'

/**
 * The agent's ownership state, said in words, with the one control that changes
 * it.
 *
 * Ownership is not decoration here: it now decides who may rewrite the agent.
 * "Team-owned" means every member entitled to the agent may edit it;
 * "Owned by <person>" means that person and organization owners may. A person
 * looking at an agent they cannot edit should be able to read why, and to see
 * whom to ask — so the state is on the header rather than buried in a table
 * cell (Rule zero: every element names the decision it drives).
 *
 * The control appears only for someone entitled to use it: transferring
 * ownership to the team is the owner's or an organization owner's act, and claiming a team-owned
 * agent is organization-owner-only, because an edit helps everyone while a
 * claim locks everyone else out.
 */

type AgentOwnershipStateProps = {
  agent: AgentRecord
}

export const agentOwnershipLabel = (agent: AgentRecord, viewer: AgentEditViewer): string => {
  const state = agentOwnershipState(agent)
  const ownerName = agent.owner?.displayName ?? 'another member'
  const isViewerOwner = Boolean(viewer.userId) && agent.ownerUserId === viewer.userId

  return state === 'private' || state === 'person_owned'
    ? isViewerOwner
      ? 'Owned by you'
      : `Owned by ${ownerName}`
    : 'Team-owned'
}

export const AgentOwnershipState = ({ agent }: AgentOwnershipStateProps) => {
  const viewer = useAgentEditViewer()
  const updateAgent = useUpdateAgent()
  const [pendingAction, setPendingAction] = useState<'transfer' | 'claim' | null>(null)

  const state = agentOwnershipState(agent)
  if (state === 'system') return null

  const label = agentOwnershipLabel(agent, viewer)

  const mayChangeOwner = canChangeAgentOwner(agent, viewer)
  // Transferring ownership hands editing to everyone entitled; claiming takes it away from
  // them. Both are the same PUT field, and both deserve a confirmation.
  const action =
    !mayChangeOwner
      ? null
      : state === 'person_owned'
        ? ('transfer' as const)
        : state === 'team_owned' && viewer.isOrgOwner
          ? ('claim' as const)
          : null

  const confirm = () => {
    if (!pendingAction) return
    updateAgent.mutate(
      {
        agentId: agent.id,
        ownerUserId: pendingAction === 'transfer' ? null : viewer.userId,
      },
      { onSettled: () => setPendingAction(null) },
    )
  }

  return (
    <span className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[color:var(--tx3)]">
      <AgentVisibilityPill visibility={agent.visibility} />
      <span data-testid="agent-ownership-state">{label}</span>
      {action ? (
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          data-testid="agent-ownership-action"
          disabled={updateAgent.isPending}
          onClick={() => setPendingAction(action)}
          type="button"
        >
          {action === 'transfer' ? 'Transfer ownership to team' : 'Take ownership'}
        </button>
      ) : null}
      <ConfirmDialog
        body={
          pendingAction === 'transfer'
            ? 'Everyone who can access this agent through a channel can edit its instructions, '
              + 'model, tools and limits.'
            : 'Only you and organisation owners will be able to edit this agent afterwards.'
        }
        confirmLabel={pendingAction === 'transfer' ? 'Transfer ownership to team' : 'Take ownership'}
        onCancel={() => setPendingAction(null)}
        onConfirm={confirm}
        open={pendingAction !== null}
        pending={updateAgent.isPending}
        title={
          pendingAction === 'transfer'
            ? `Transfer ownership of ${agent.name} to the team?`
            : `Take ownership of ${agent.name}?`
        }
      />
    </span>
  )
}
