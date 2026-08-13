import { TriggerDetail } from '../components/features/triggers/TriggerDetail'
import { TriggerEditorDialog } from '../components/features/triggers/TriggerEditorDialog'
import { TriggerListColumn } from '../components/features/triggers/TriggerListColumn'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { useMobileLayout } from '../lib/mobile-shell'
import { PhoneNavigationButton } from '../layouts/admin-shell/PhoneNavigationButton'
import { useTriggersPageState } from './triggers/useTriggersPageState'

export const TriggersPage = () => {
  const isMobile = useMobileLayout()
  const state = useTriggersPageState()

  if (!state.isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  const { selectedTrigger } = state

  const columns = [
    <TriggerListColumn
      effectiveTriggerId={state.effectiveTriggerId}
      filteredTriggers={state.filteredTriggers}
      key="triggers"
      leading={<PhoneNavigationButton />}
      onCreate={() => state.setCreateDialogOpen(true)}
      onSearchChange={state.setSearchQuery}
      onSelect={state.setSelectedTriggerId}
      onStatusFilterChange={state.setStatusFilter}
      onTypeFilterChange={state.setTypeFilter}
      registry={state.registry}
      searchQuery={state.searchQuery}
      statusCounts={state.statusCounts}
      statusFilter={state.statusFilter}
      totalCount={state.totalCount}
      typeFilter={state.typeFilter}
    />,
  ]

  if (selectedTrigger) {
    columns.push(
      <ColumnBrowserColumn
        key={`trigger-${selectedTrigger.id}`}
        onBack={() => state.setSelectedTriggerId(undefined)}
        showBack={isMobile}
        title={selectedTrigger.name ?? selectedTrigger.type}
      >
        <TriggerDetail
          onDeleted={() => state.setSelectedTriggerId(undefined)}
          onEdit={() => state.setEditingTriggerId(selectedTrigger.id)}
          registry={state.registry}
          trigger={selectedTrigger}
        />
      </ColumnBrowserColumn>,
    )
  }

  return (
    <div className="h-full w-full">
      <ColumnBrowserViewport
        activeColumn={state.selectedTriggerId && selectedTrigger ? 1 : 0}
        columns={columns}
      />
      <TriggerEditorDialog
        agents={state.agents}
        channels={state.channels}
        defaultTarget={state.defaultCreateTarget}
        onClose={() => {
          state.setCreateDialogOpen(false)
          state.setEditingTriggerId(undefined)
        }}
        onSaved={(trigger) => {
          state.setSelectedTriggerId(trigger.id)
        }}
        open={state.isCreateDialogOpen || Boolean(state.editingTrigger)}
        trigger={state.editingTrigger}
        workflowInstallations={state.workflowInstallations}
        workflowTemplates={state.workflowTemplates}
      />
    </div>
  )
}
