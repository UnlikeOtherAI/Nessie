import { useEffect, useMemo, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import { useTriggers } from '../../facades/triggers/hooks'
import { useAgents } from '../../facades/agents/hooks'
import { useChannels } from '../../facades/channels/hooks'
import {
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../../facades/workflows/hooks'
import { useIsOwner } from '../../components/shared/OwnerGate'
import { parseHashAnchor, useConsumedHashIntent } from '../../navigation/intent'
import { useTabParam } from '../../navigation/useTabParam'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../lib/api-client'
import {
  formatTriggerTarget,
  type TriggerRegistryMaps,
} from '../../components/features/triggers/trigger-presentation'

type CreateTarget =
  | { targetKind: 'agent'; agentId: string; targetChannelId?: string }
  | { targetKind: 'workflow'; workflowInstallationId: string }
  | undefined

export type TriggerStatusFilter = 'all' | AgentTriggerRecord['status']

// The four segments the status strip offers, and what `?status=` is validated
// against — a status the strip does not list (needs_reauthorization) reads as
// All rather than silently emptying the list.
export const TRIGGER_STATUS_FILTERS: readonly TriggerStatusFilter[] = [
  'all',
  'active',
  'paused',
  'error',
]
export type TriggerTypeFilter = 'all' | AgentTriggerRecord['type']

export type TriggerStatusCounts = Record<TriggerStatusFilter, number>

export type TriggersPageState = {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  defaultCreateTarget: CreateTarget
  editingTrigger?: AgentTriggerRecord
  effectiveTriggerId?: string
  filteredTriggers: AgentTriggerRecord[]
  isCreateDialogOpen: boolean
  /** The triggers read has not settled; the list shows a skeleton, not "none yet". */
  isPending: boolean
  registry: TriggerRegistryMaps
  searchQuery: string
  selectedTrigger?: AgentTriggerRecord
  selectedTriggerId?: string
  setCreateDialogOpen: (open: boolean) => void
  setEditingTriggerId: (triggerId: string | undefined) => void
  setSearchQuery: (query: string) => void
  setSelectedTriggerId: (triggerId: string | undefined) => void
  setStatusFilter: (filter: TriggerStatusFilter) => void
  setTypeFilter: (filter: TriggerTypeFilter) => void
  statusCounts: TriggerStatusCounts
  statusFilter: TriggerStatusFilter
  totalCount: number
  triggersQuery: UseQueryResult<AgentTriggerRecord[]>
  typeFilter: TriggerTypeFilter
  workflowInstallations: WorkflowInstallationRecord[]
  workflowTemplates: WorkflowTemplateRecord[]
}

const parseTriggerHash = parseHashAnchor('trigger')

export const useTriggersPageState = (): TriggersPageState => {
  // The three owner-only reads below stay gated on this flag; the page's
  // refusal is <OwnerGate>, which asks the same question of the same session.
  const isOwner = useIsOwner()
  const triggersQuery = useTriggers(isOwner)
  const triggers = triggersQuery.data ?? []
  const triggersPending = triggersQuery.isPending
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const { data: workflowInstallations = [] } = useWorkflowInstallations(isOwner)
  const { data: workflowTemplates = [] } = useWorkflowTemplates(isOwner)
  const [selectedTriggerId, setSelectedTriggerId] = useState<string | undefined>(
    undefined,
  )
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingTriggerId, setEditingTriggerId] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  // The status narrowing is part of what the list shows, so it lives in the
  // URL: `/triggers?status=error` is linkable and survives a refresh, and
  // Back leaves the page rather than undoing the filter.
  const [statusFilter, setStatusFilter] = useTabParam('status', TRIGGER_STATUS_FILTERS, 'all')
  const [typeFilter, setTypeFilter] = useState<TriggerTypeFilter>('all')

  // Soonest-to-fire first, so the list itself answers "what runs next" and no
  // separate queue section is needed; triggers with nothing scheduled follow
  // alphabetically.
  const sortedTriggers = useMemo(
    () =>
      [...triggers].sort((left, right) => {
        const leftNext = left.enabled && left.nextRunAt ? left.nextRunAt : undefined
        const rightNext = right.enabled && right.nextRunAt ? right.nextRunAt : undefined
        if (leftNext && rightNext) return leftNext.localeCompare(rightNext)
        if (leftNext) return -1
        if (rightNext) return 1
        return (left.name ?? left.type).localeCompare(right.name ?? right.type)
      }),
    [triggers],
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

  const filteredTriggers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return sortedTriggers.filter((trigger) => {
      if (statusFilter !== 'all' && trigger.status !== statusFilter) return false
      if (typeFilter !== 'all' && trigger.type !== typeFilter) return false
      if (!query) return true

      const haystack = [
        trigger.name ?? '',
        trigger.description ?? '',
        trigger.type,
        formatTriggerTarget(trigger, registry),
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
  }, [registry, searchQuery, sortedTriggers, statusFilter, typeFilter])

  // A "scheduled" link (`/agents/triggers#trigger-<id>`) selects its row
  // once; the fragment is consumed, so Back and a refresh keep the person's
  // own later selection (docs/navigation.md §8).
  const linkedTrigger = useConsumedHashIntent('trigger', parseTriggerHash)
  useEffect(() => {
    if (linkedTrigger.value) setSelectedTriggerId(linkedTrigger.value)
  }, [linkedTrigger])

  const statusCounts = useMemo<TriggerStatusCounts>(
    () => ({
      all: sortedTriggers.length,
      active: sortedTriggers.filter((trigger) => trigger.status === 'active').length,
      paused: sortedTriggers.filter((trigger) => trigger.status === 'paused').length,
      error: sortedTriggers.filter((trigger) => trigger.status === 'error').length,
      needs_reauthorization: sortedTriggers.filter(
        (trigger) => trigger.status === 'needs_reauthorization',
      ).length,
    }),
    [sortedTriggers],
  )

  const effectiveTriggerId =
    selectedTriggerId && sortedTriggers.some((trigger) => trigger.id === selectedTriggerId)
      ? selectedTriggerId
      : filteredTriggers[0]?.id

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
    agents,
    channels,
    defaultCreateTarget,
    editingTrigger,
    effectiveTriggerId,
    filteredTriggers,
    isCreateDialogOpen: createDialogOpen,
    // A disabled query reports `pending` forever, so a non-owner (whose
    // refusal is <OwnerGate>) must not read as loading.
    isPending: isOwner && triggersPending,
    registry,
    searchQuery,
    selectedTrigger,
    selectedTriggerId,
    setCreateDialogOpen,
    setEditingTriggerId,
    setSearchQuery,
    setSelectedTriggerId,
    setStatusFilter,
    setTypeFilter,
    statusCounts,
    statusFilter,
    totalCount: sortedTriggers.length,
    triggersQuery,
    typeFilter,
    workflowInstallations,
    workflowTemplates,
  }
}
