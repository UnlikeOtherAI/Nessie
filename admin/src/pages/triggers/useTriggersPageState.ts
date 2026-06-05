import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTriggers, useUpcomingTriggers } from '../../facades/triggers/hooks'
import { useAgents } from '../../facades/agents/hooks'
import { useChannels } from '../../facades/channels/hooks'
import {
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../../facades/workflows/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../lib/api-client'
import { parseTriggerHash, type TriggerRegistryMaps } from './trigger-presentation'

type CreateTarget =
  | { targetKind: 'agent'; agentId: string; targetChannelId?: string }
  | { targetKind: 'workflow'; workflowInstallationId: string }
  | undefined

export type TriggersPageState = {
  activeCount: number
  agents: AgentRecord[]
  channels: ChannelRecord[]
  defaultCreateTarget: CreateTarget
  editingTrigger?: AgentTriggerRecord
  effectiveTriggerId?: string
  isOwner: boolean
  registry: TriggerRegistryMaps
  scheduledTriggers: AgentTriggerRecord[]
  selectedTrigger?: AgentTriggerRecord
  selectedTriggerId?: string
  setCreateDialogOpen: (open: boolean) => void
  setEditingTriggerId: (triggerId: string | undefined) => void
  setSelectedTriggerId: (triggerId: string | undefined) => void
  sortedTriggers: AgentTriggerRecord[]
  workflowInstallations: WorkflowInstallationRecord[]
  workflowTemplates: WorkflowTemplateRecord[]
  isCreateDialogOpen: boolean
}

export const useTriggersPageState = (): TriggersPageState => {
  const location = useLocation()
  const { me } = useAuthSession()
  const isOwner = me?.user.roleIds.includes('owner') ?? false
  const { data: triggers = [] } = useTriggers(isOwner)
  const { data: scheduled = [] } = useUpcomingTriggers(isOwner)
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const { data: workflowInstallations = [] } = useWorkflowInstallations(isOwner)
  const { data: workflowTemplates = [] } = useWorkflowTemplates(isOwner)
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | undefined>(
    undefined,
  )
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingTriggerId, setEditingTriggerId] = useState<string | undefined>(undefined)

  const sortedTriggers = useMemo(
    () =>
      [...triggers].sort((left, right) =>
        (left.name ?? left.type).localeCompare(right.name ?? right.type),
      ),
    [triggers],
  )

  const scheduledTriggers = useMemo(
    () =>
      [...scheduled].sort((left, right) =>
        (left.nextRunAt ?? '').localeCompare(right.nextRunAt ?? ''),
      ),
    [scheduled],
  )

  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  )
  const channelsById = useMemo(
    () => new Map(channels.map((channel) => [channel.id, channel])),
    [channels],
  )
  const workflowInstallationsById = useMemo(
    () =>
      new Map(
        workflowInstallations.map((installation) => [installation.id, installation]),
      ),
    [workflowInstallations],
  )
  const workflowTemplatesById = useMemo(
    () => new Map(workflowTemplates.map((template) => [template.id, template])),
    [workflowTemplates],
  )
  const registry = useMemo<TriggerRegistryMaps>(
    () => ({
      agentsById,
      channelsById,
      workflowInstallationsById,
      workflowTemplatesById,
    }),
    [agentsById, channelsById, workflowInstallationsById, workflowTemplatesById],
  )

  useEffect(() => {
    const hashedTriggerId = parseTriggerHash(location.hash)
    if (hashedTriggerId) setSelectedTriggerId(hashedTriggerId)
  }, [location.hash])

  const activeCount = useMemo(
    () => sortedTriggers.filter((trigger) => trigger.status === 'active').length,
    [sortedTriggers],
  )

  const effectiveTriggerId =
    selectedTriggerId && sortedTriggers.some((trigger) => trigger.id === selectedTriggerId)
      ? selectedTriggerId
      : sortedTriggers[0]?.id

  const selectedTrigger = useMemo(
    () => sortedTriggers.find((trigger) => trigger.id === effectiveTriggerId),
    [effectiveTriggerId, sortedTriggers],
  )
  const editingTrigger = useMemo(
    () => sortedTriggers.find((trigger) => trigger.id === editingTriggerId),
    [editingTriggerId, sortedTriggers],
  )
  const defaultCreateTarget = useMemo<CreateTarget>(() => {
    if (!selectedTrigger) {
      return undefined
    }

    if (selectedTrigger.agentId) {
      return {
        targetKind: 'agent' as const,
        agentId: selectedTrigger.agentId,
        targetChannelId: selectedTrigger.targetChannelId,
      }
    }

    if (selectedTrigger.workflowInstallationId) {
      return {
        targetKind: 'workflow' as const,
        workflowInstallationId: selectedTrigger.workflowInstallationId,
      }
    }

    return undefined
  }, [selectedTrigger])

  return {
    activeCount,
    agents,
    channels,
    defaultCreateTarget,
    editingTrigger,
    effectiveTriggerId,
    isOwner,
    registry,
    scheduledTriggers,
    selectedTrigger,
    selectedTriggerId,
    setCreateDialogOpen,
    setEditingTriggerId,
    setSelectedTriggerId,
    sortedTriggers,
    workflowInstallations,
    workflowTemplates,
    isCreateDialogOpen: createDialogOpen,
  }
}
