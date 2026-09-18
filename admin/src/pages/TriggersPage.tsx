import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { TriggerEditorDialog } from '../components/features/triggers/TriggerEditorDialog'
import { TriggersTable } from '../components/features/triggers/TriggersTable'
import { createListPageStore } from '../components/shared/list-page-state'
import {
  useTriggersPageState,
  type TriggerTypeFilter,
} from '../components/features/triggers/useTriggersPageState'
import { Select } from '../components/shared/FormControls'
import { ListToolbar } from '../components/shared/ListToolbar'
import { OwnerGate } from '../components/shared/OwnerGate'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { TabBar } from '../components/primitives/TabBar'
import { useScrollMemory } from '../hooks/useScrollMemory'

const TYPE_OPTIONS: Array<{ label: string; value: TriggerTypeFilter }> = [
  { label: 'All types', value: 'all' },
  { label: 'Manual', value: 'manual' },
  { label: 'Schedule', value: 'scheduled' },
  { label: 'Interval', value: 'interval' },
  { label: 'Webhook', value: 'webhook' },
  { label: 'Event', value: 'event' },
]

/**
 * Triggers — the automation list.
 *
 * It was a column browser: a filtered rail on the left and the selected
 * trigger's whole detail beside it, with the selection carried in `?trigger=`.
 * It is now the section's ordinary shape — one header whose tabs are the
 * status strip, one table, one pager — and a trigger is its own screen at
 * `/agents/triggers/:triggerId`. Creating and editing were already a dialog
 * and stay one.
 */
const triggersListStore = createListPageStore()

export const TriggersPage = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const state = useTriggersPageState()

  const [initialState] = useState(triggersListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  // `/agents/triggers?trigger=<id>` was this page's own selection state before
  // a trigger had an address of its own. Anything still holding that link —
  // a bookmark, an older notification — lands on the trigger it names.
  const legacySelection = searchParams.get('trigger')
  useEffect(() => {
    if (legacySelection) {
      void navigate(`/agents/triggers/${encodeURIComponent(legacySelection)}`, { replace: true })
    }
  }, [legacySelection, navigate])

  const { filteredTriggers } = state
  const totalPages = Math.max(1, Math.ceil(filteredTriggers.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageTriggers = filteredTriggers.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = filteredTriggers.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, filteredTriggers.length)

  useEffect(() => {
    triggersListStore.save({ page, pageSize })
  }, [page, pageSize])

  const scroll = useScrollMemory('triggers:list')

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The status strip is the header's own tabs slot, as the agents list's
          scope strip is: the section has one header rather than a hero with a
          second bar of filters under it. The header is always rendered — a
          refusal is a state of this screen, not a screen of its own, so Back
          and the `h1` the settle focuses never disappear with it
          (docs/navigation/deep-links-and-headers.md §9). Only the body below
          is owner-gated. */}
      <ScreenHeader
        actions={[{
          icon: faPlus,
          id: 'new-trigger',
          label: 'New trigger',
          onSelect: () => state.setCreateDialogOpen(true),
          primary: true,
          priority: 100,
        }]}
        eyebrow="Agents"
        subtitle={
          <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
            What wakes an agent or a workflow without anybody asking: a schedule, a repeating
            interval, an incoming webhook, or a system event.
          </p>
        }
        tabs={
          <TabBar
            ariaLabel="Filter by status"
            items={[
              { count: state.statusCounts.all, label: 'All', value: 'all' },
              { count: state.statusCounts.active, label: 'Active', value: 'active' },
              { count: state.statusCounts.paused, label: 'Paused', value: 'paused' },
              { count: state.statusCounts.error, label: 'Error', value: 'error' },
            ]}
            onChange={state.setStatusFilter}
            value={state.statusFilter}
          />
        }
        title="Triggers"
      />

      <div
        className="min-h-0 flex-1 overflow-y-auto px-[var(--page-gutter)] py-4"
        onScroll={scroll.onScroll}
        ref={scroll.ref}
      >
        <OwnerGate>
          <div className="grid gap-3">
            <ListToolbar
              search={{
                label: 'Search triggers',
                onChange: (value) => {
                  state.setSearchQuery(value)
                  setRequestedPage(0)
                },
                placeholder: 'Search triggers…',
                value: state.searchQuery,
              }}
            >
              <Select
                aria-label="Filter by type"
                onChange={(event) => {
                  state.setTypeFilter(event.target.value as TriggerTypeFilter)
                  setRequestedPage(0)
                }}
                size="compact"
                value={state.typeFilter}
              >
                {TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </ListToolbar>

            <TriggersTable
              emptyMessage={
                state.totalCount === 0
                  ? 'No triggers yet. Create one to wake an agent or workflow automatically.'
                  : 'No triggers match the current filters.'
              }
              isLoading={state.isPending}
              onOpen={(triggerId) => void navigate(`/agents/triggers/${triggerId}`)}
              registry={state.registry}
              triggers={pageTriggers}
            />
          </div>
        </OwnerGate>
      </div>

      {/* Always visible: an empty or single-page list keeps its size control,
          and the table above it does not grow and shrink as pages change. */}
      <PaginationFooter
        canNext={page < totalPages - 1}
        canPrevious={page > 0}
        className="px-6 py-3"
        label={
          filteredTriggers.length === 0
            ? 'No triggers'
            : `${rangeStart}–${rangeEnd} of ${filteredTriggers.length}`
        }
        onPageChange={setRequestedPage}
        onPageSizeChange={(next) => {
          setPageSize(next)
          setRequestedPage(0)
        }}
        page={page}
        pageCount={totalPages}
        pageSize={pageSize}
      />

      <TriggerEditorDialog
        agents={state.agents}
        channels={state.channels}
        defaultTarget={state.defaultCreateTarget}
        onClose={() => state.setCreateDialogOpen(false)}
        onSaved={(trigger) => void navigate(`/agents/triggers/${trigger.id}`)}
        open={state.isCreateDialogOpen}
        workflowInstallations={state.workflowInstallations}
        workflowTemplates={state.workflowTemplates}
      />
    </div>
  )
}
