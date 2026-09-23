import { useMemo } from 'react'

import { useAgents } from '../../../facades/agents/queries'
import { useChannels } from '../../../facades/channels/hooks'
import type { BoardColumnView } from '../projects/kanban/kanban-config'
import { TriggerEditorDialog } from '../triggers/TriggerEditorDialog'
import { isTicketTargetChannel } from '../triggers/ticket-trigger-form'
import type { DefaultTarget } from '../triggers/trigger-config'

/**
 * "Start work with an agent…" from a board column's menu
 * (docs/plans/2026-09-23-ticket-driven-agents/setup-and-ui.md → "Screens"):
 * the Triggers editor itself, opened on a ticket trigger for this board with
 * this column as its start-work column. Only this project's channels are
 * offered, because a ticket trigger works the boards of its channel's project,
 * and the agents offered first are the ones already in a public channel here.
 * The column menu is shown only to people the Triggers routes let create one.
 */

type BoardStartWorkDialogProps = {
  boardId: string
  column: BoardColumnView
  onClose: () => void
  projectId: string
}

export const BoardStartWorkDialog = ({ boardId, column, onClose, projectId }: BoardStartWorkDialogProps) => {
  const agentsQuery = useAgents()
  const channelsQuery = useChannels()
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])
  const channels = useMemo(() => channelsQuery.data ?? [], [channelsQuery.data])
  const projectChannels = useMemo(
    () => channels.filter((channel) => channel.projectId === projectId),
    [channels, projectId],
  )
  const workRooms = useMemo(() => projectChannels.filter(isTicketTargetChannel), [projectChannels])
  const ready = useMemo(
    () => agents.filter((agent) => agent.channelIds.some((id) => workRooms.some((room) => room.id === id))),
    [agents, workRooms],
  )
  const offered = ready.length > 0 ? ready : agents
  const first = offered[0]
  const defaultTarget = useMemo<DefaultTarget | undefined>(() => first
    ? {
        agentId: first.id,
        targetChannelId: workRooms.find((room) => first.channelIds.includes(room.id))?.id,
        targetKind: 'agent',
        prefill: {
          name: `Start work from ${column.name}`,
          ticket: { boardId, pickupColumnIds: [column.id] },
          triggerType: 'ticket_changed',
        },
      }
    : undefined, [boardId, column.id, column.name, first, workRooms])

  // The editor seeds its draft once, from what it is given when it opens, so it
  // opens only once the agents and channels it prefills from have loaded.
  if (!agentsQuery.isSuccess || !channelsQuery.isSuccess) return null

  return (
    <TriggerEditorDialog
      agents={offered}
      channels={projectChannels}
      defaultTarget={defaultTarget}
      draftId={`board:${boardId}:${column.id}`}
      onClose={onClose}
      onSaved={() => {}}
      open
      workflowInstallations={[]}
      workflowTemplates={[]}
    />
  )
}
