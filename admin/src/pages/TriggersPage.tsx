import { TriggerDetail } from '../components/features/triggers/TriggerDetail'
import { TriggerEditorDialog } from '../components/features/triggers/TriggerEditorDialog'
import { TriggerListColumn } from '../components/features/triggers/TriggerListColumn'
import { ColumnBrowserColumn } from '../components/shared/column-browser/ColumnBrowserColumn'
import { ColumnBrowserViewport } from '../components/shared/column-browser/ColumnBrowserViewport'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useTriggersPageState } from './triggers/useTriggersPageState'

export const TriggersPage = () => {
  const isMobile = useMediaQuery('(max-width: 767px)')
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
      activeCount={state.activeCount}
      effectiveTriggerId={state.effectiveTriggerId}
      key="triggers"
      onCreate={() => state.setCreateDialogOpen(true)}
      onSelect={state.setSelectedTriggerId}
      registry={state.registry}
      scheduledTriggers={state.scheduledTriggers}
      sortedTriggers={state.sortedTriggers}
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
