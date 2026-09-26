import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { UseQueryResult } from '@tanstack/react-query'
import { useTriggers } from '../../../facades/triggers/hooks'
import { useAgents } from '../../../facades/agents/hooks'
import { useChannels } from '../../../facades/channels/hooks'
import {
  useWorkflowInstallations,
  useWorkflowTemplates,
} from '../../../facades/workflows/hooks'
import { useIsOwner } from '../../../facades/auth/hooks'
import { useConsumedIntent } from '../../../navigation/intent'
import { useTabParam } from '../../../navigation/useTabParam'
import type {
  AgentRecord,
  AgentTriggerRecord,
  ChannelRecord,
  WorkflowInstallationRecord,
  WorkflowTemplateRecord,
} from '../../../lib/api-client'
import {
  formatTriggerTarget,
  type TriggerRegistryMaps,
} from './trigger-presentation'

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

// The type select's own segments, and what `?type=` is validated against —
// mirrors `TRIGGER_STATUS_FILTERS` beside it, so an unknown or absent value
// reads as All rather than emptying the list.
export const TRIGGER_TYPE_FILTERS: readonly TriggerTypeFilter[] = [
  'all',
  'manual',
  'scheduled',
  'interval',
  'webhook',
  'event',
  'ticket_changed',
  'document_changed',
]

export type TriggerStatusCounts = Record<TriggerStatusFilter, number>

export type TriggerRegistry = {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  registry: TriggerRegistryMaps
  workflowInstallations: WorkflowInstallationRecord[]
  workflowTemplates: WorkflowTemplateRecord[]
}

/**
 * What a trigger's target *is*, resolved to names. Both the list and a single
 * trigger's screen need it — a row says "Agent X in #general" and so does the
 * detail's fact list — so it is one hook rather than a prop threaded down a
 * column browser that no longer exists.
 */
export const useTriggerRegistry = (): TriggerRegistry => {
  const isOwner = useIsOwner()
  const { data: agents = [] } = useAgents()
  const { data: channels = [] } = useChannels()
  const { data: workflowInstallations = [] } = useWorkflowInstallations(isOwner)
  const { data: workflowTemplates = [] } = useWorkflowTemplates(isOwner)

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

  return { agents, channels, registry, workflowInstallations, workflowTemplates }
}

export type TriggersPageState = TriggerRegistry & {
  defaultCreateTarget: CreateTarget
  filteredTriggers: AgentTriggerRecord[]
  isCreateDialogOpen: boolean
  /** The triggers read has not settled; the list shows a skeleton, not "none yet". */
  isPending: boolean
  searchQuery: string
  setCreateDialogOpen: (open: boolean) => void
  setSearchQuery: (query: string) => void
  setStatusFilter: (filter: TriggerStatusFilter) => void
  setTypeFilter: (filter: TriggerTypeFilter) => void
  statusCounts: TriggerStatusCounts
  statusFilter: TriggerStatusFilter
  totalCount: number
  triggersQuery: UseQueryResult<AgentTriggerRecord[]>
  typeFilter: TriggerTypeFilter
}

export const useTriggersPageState = (): TriggersPageState => {
  // The four owner-only reads stay gated on this flag; the page's refusal is
  // <OwnerGate>, which asks the same question of the same session.
  const isOwner = useIsOwner()
  const triggersQuery = useTriggers(isOwner)
  // Memoised: the empty-array fallback would otherwise be a fresh literal on
  // every render, and the sort/filter memos below key off this identity.
  const triggers = useMemo(() => triggersQuery.data ?? [], [triggersQuery.data])
  const triggersPending = triggersQuery.isPending
  const directory = useTriggerRegistry()
  const { registry } = directory
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  // `/admin/automations?create=<agentId>` — the "New trigger" button on an
  // agent's own Triggers panel. The doorway lands in the create form already
  // pointed at that agent rather than on a list the person then has to find it
  // in; the registry declares `create` on this surface (it is the same intent
  // the project → executors doorway uses), so the value is consumed once and
  // stripped, and Back leaves the page instead of reopening the dialog.
  const createForAgent = useConsumedIntent('create')
  const [createTargetAgentId, setCreateTargetAgentId] = useState<string | undefined>(undefined)
  // The search phrase and the status/type narrowing are all part of what the
  // list shows, so they live in the URL: `/admin/automations?status=error` is
  // linkable and survives a refresh, and Back leaves the page rather than
  // undoing the filter (docs/navigation/overview.md §1).
  const [searchParams, setSearchParams] = useSearchParams()
  const searchQuery = searchParams.get('search') ?? ''
  const setSearchQuery = useCallback(
    (next: string) => {
      setSearchParams(
        (current) => {
          const params = new URLSearchParams(current)
          if (next) params.set('search', next)
          else params.delete('search')
          return params
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )
  const [statusFilter, setStatusFilter] = useTabParam('status', TRIGGER_STATUS_FILTERS, 'all')
  const [typeFilter, setTypeFilter] = useTabParam('type', TRIGGER_TYPE_FILTERS, 'all')

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

  // Keyed on the capture, not its value: two arrivals of the same agent id are
  // two presses of the button and must each open the dialog.
  useEffect(() => {
    if (!createForAgent.value) return
    setCreateTargetAgentId(createForAgent.value)
    setCreateDialogOpen(true)
  }, [createForAgent])

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

  // Only the explicit doorway scopes a new trigger now. The list has no
  // selected row to borrow a target from, and inheriting one from whichever
  // row a person happened to leave highlighted was never something they asked
  // for.
  const defaultCreateTarget = useMemo<CreateTarget>(
    () => createTargetAgentId
      ? { targetKind: 'agent' as const, agentId: createTargetAgentId }
      : undefined,
    [createTargetAgentId],
  )

  return {
    ...directory,
    defaultCreateTarget,
    filteredTriggers,
    isCreateDialogOpen: createDialogOpen,
    // A disabled query reports `pending` forever, so a non-owner (whose
    // refusal is <OwnerGate>) must not read as loading.
    isPending: isOwner && triggersPending,
    searchQuery,
    setCreateDialogOpen: (open: boolean) => {
      // Closing the dialog releases the doorway's target, so the next plain
      // "New trigger" press on this page opens an unscoped form.
      if (!open) setCreateTargetAgentId(undefined)
      setCreateDialogOpen(open)
    },
    setSearchQuery,
    setStatusFilter,
    setTypeFilter,
    statusCounts,
    statusFilter,
    totalCount: sortedTriggers.length,
    triggersQuery,
    typeFilter,
  }
}
