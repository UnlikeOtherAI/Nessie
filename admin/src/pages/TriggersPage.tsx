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
import type { SettingsTabHostProps } from '../components/shared/SettingsPanel'
import { TabBar } from '../components/primitives/TabBar'
import { useScrollMemory } from '../hooks/useScrollMemory'
import { triggerUrl } from '../facades/alerts/trigger-url'

const TYPE_OPTIONS: Array<{ label: string; value: TriggerTypeFilter }> = [
  { label: 'All types', value: 'all' },
  { label: 'Manual', value: 'manual' },
  { label: 'Schedule', value: 'scheduled' },
  { label: 'Interval', value: 'interval' },
  { label: 'Webhook', value: 'webhook' },
  { label: 'Event', value: 'event' },
  { label: 'Ticket change', value: 'ticket_changed' },
  { label: 'Document change', value: 'document_changed' },
]

/**
 * Schedules and triggers — the first tab of Automations.
 *
 * It was a column browser: a filtered rail on the left and the selected
 * trigger's whole detail beside it, with the selection carried in `?trigger=`.
 * It is now the section's ordinary shape — one header, one table, one pager —
 * and a trigger is its own screen at `/admin/automations/triggers/:triggerId`.
 * Creating and editing were already a dialog and stay one.
 */
const triggersListStore = createListPageStore()

export const TriggersPage = ({ host }: { host?: SettingsTabHostProps }) => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const state = useTriggersPageState()

  const [initialState] = useState(triggersListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  // `?trigger=<id>` was this list's own selection state before a trigger had
  // an address of its own; a link that still carries one lands on the trigger
  // it names.
  const legacySelection = searchParams.get('trigger')
  useEffect(() => {
    if (legacySelection) {
      void navigate(triggerUrl(legacySelection), { replace: true })
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
      {/* One header for the Automations screen: its tab strip is the host's,
          so the status strip is the list's own filter, beside the search. The
          header is always rendered — a refusal is a state of this screen, not
          a screen of its own, so Back and the `h1` the settle focuses never
          disappear with it (docs/navigation/deep-links-and-headers.md §9).
          Only the body below is owner-gated. */}
      <ScreenHeader
        actions={[{
          icon: faPlus,
          id: 'new-trigger',
          label: 'New trigger',
          onSelect: () => state.setCreateDialogOpen(true),
          primary: true,
          priority: 100,
        }]}
        eyebrow={host?.eyebrow ?? 'Agents'}
        subtitle={
          <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
            What wakes an agent or a workflow without anybody asking: a schedule, a repeating
            interval, an incoming webhook, or a system event.
          </p>
        }
        tabs={host?.tabs}
        title={host?.title ?? 'Schedules and triggers'}
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
              <TabBar
                ariaLabel="Filter by status"
                items={[
                  { count: state.statusCounts.all, label: 'All', value: 'all' },
                  { count: state.statusCounts.active, label: 'Active', value: 'active' },
                  { count: state.statusCounts.paused, label: 'Paused', value: 'paused' },
                  { count: state.statusCounts.error, label: 'Error', value: 'error' },
                ]}
                onChange={(next) => {
                  state.setStatusFilter(next)
                  setRequestedPage(0)
                }}
                role="radiogroup"
                value={state.statusFilter}
              />
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
              onOpen={(triggerId) => void navigate(triggerUrl(triggerId))}
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
        onSaved={(trigger) => void navigate(triggerUrl(trigger.id))}
        open={state.isCreateDialogOpen}
        workflowInstallations={state.workflowInstallations}
        workflowTemplates={state.workflowTemplates}
      />
    </div>
  )
}
