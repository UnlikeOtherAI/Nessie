import { useCallback, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  DeploymentModelsTable,
  pairId,
} from '../../components/features/inference-models/DeploymentModelsTable'
import { FormError, FormSuccess } from '../../components/shared/FormActions'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { Input } from '../../components/shared/FormControls'
import { ListToolbar } from '../../components/shared/ListToolbar'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import type { SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import {
  useDeploymentModelCatalog,
  useSetDeploymentModelsEnabled,
  useSetDeploymentModelEnabled,
  useTestDeploymentModel,
  type DeploymentModelRecord,
} from '../../facades/inference-models/hooks'

type TestOutcome = { latencyMs: number; message: string; ok: boolean }
type BulkAction = 'disable' | 'enable'

/**
 * The shared organization/team model-availability surface.
 *
 * The list is **Ledger's live catalogue**, not a local table: nothing in Nessie
 * enumerates "the models available in the deployment", so the page reads what
 * Ledger actually offers and folds the organisation's own decisions onto it. A
 * pair nobody has had an opinion about is available — that is the Ledger
 * default — and a catalogue that cannot be read says so instead of rendering a
 * list that may no longer be true.
 *
 * The server supplies the authorized catalogue for the requested scope. In
 * team mode that is already intersected with the organization's enabled set,
 * so this shared view never learns about an org-disabled pair. Switching a
 * pair off is real rather than decorative: the Agent Designer's picker stops
 * offering it and every agent write path refuses a move onto it. Agents already
 * pinned to it keep running, which is why each row states the affected count.
 *
 * Personal model subscriptions are deliberately out of scope — an organisation
 * owner has no standing to enable, disable or spend a person's own consumer
 * plan (docs/standards/personal-model-subscriptions.md).
 */
type ModelAvailabilitySettingsProps = SettingsTabHostProps & { teamId?: string }

export const ModelAvailabilitySettings = ({ tabs, teamId }: ModelAvailabilitySettingsProps) => {
  // A toggle or a test that failed silently would leave an owner believing the
  // deployment was in a state it is not — the one outcome this page must never
  // produce.
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null)
  const [pendingPair, setPendingPair] = useState<string | null>(null)
  const [testingPair, setTestingPair] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})

  const [searchParams, setSearchParams] = useSearchParams()
  const modelFilter = searchParams.get('model') ?? ''
  const providerFilter = searchParams.get('provider') ?? ''
  const debouncedModelFilter = useDebouncedValue(modelFilter, 150)
  const debouncedProviderFilter = useDebouncedValue(providerFilter, 150)
  const filters = {
    model: debouncedModelFilter.trim() || undefined,
    provider: debouncedProviderFilter.trim() || undefined,
  }

  const catalog = useDeploymentModelCatalog(true, filters, teamId)
  const setBulkEnabled = useSetDeploymentModelsEnabled(teamId)
  const setEnabled = useSetDeploymentModelEnabled(teamId)
  const testModel = useTestDeploymentModel()

  const catalogError = catalog.query.isError
    ? catalog.query.error instanceof Error
      ? catalog.query.error.message
      : 'The model catalogue could not be read.'
    : null

  const setFilter = useCallback((key: 'model' | 'provider', value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (value) next.set(key, value)
      else next.delete(key)
      // A cursor belongs to the old result set. Filtering always starts from
      // the first page, while retaining the person's chosen page size.
      next.delete('cursor')
      next.delete('direction')
      next.delete('page')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const onToggle = (model: DeploymentModelRecord, enabled: boolean) => {
    setActionError(null)
    setActionMessage(null)
    setPendingPair(pairId(model))
    setEnabled.mutate(
      { enabled, model: model.model, provider: model.provider },
      {
        onError: (error) =>
          setActionError(
            error instanceof Error
              ? error.message
              : 'That model could not be changed. Nothing was saved.',
          ),
        onSettled: () => setPendingPair(null),
      },
    )
  }

  const onTest = (model: DeploymentModelRecord) => {
    const id = pairId(model)
    setActionError(null)
    setTestingPair(id)
    testModel.mutate(
      { model: model.model, provider: model.provider },
      {
        onError: (error) =>
          setActionError(
            error instanceof Error
              ? error.message
              : 'The test could not be sent. Nothing was billed.',
          ),
        onSettled: () => setTestingPair(null),
        onSuccess: (result) =>
          setTestResults((current) => ({
            ...current,
            [id]: {
              latencyMs: result.latencyMs,
              message: result.ok
                ? result.reply ?? 'The model answered.'
                : result.failure?.message ?? 'The provider gave no reason.',
              ok: result.ok,
            },
          })),
      },
    )
  }

  const onBulkConfirm = () => {
    if (!bulkAction) return
    const enabled = bulkAction === 'enable'
    setActionError(null)
    setActionMessage(null)
    setBulkEnabled.mutate(
      { ...filters, enabled },
      {
        onError: (error) => {
          setBulkAction(null)
          setActionError(
            error instanceof Error
              ? error.message
              : 'The matching models could not be changed. Nothing was saved.',
          )
        },
        onSuccess: (result) => {
          setBulkAction(null)
          setActionMessage(
            `${enabled ? 'Enabled' : 'Disabled'} ${result.updatedCount} ${
              result.updatedCount === 1 ? 'model' : 'models'
            } across the full catalogue.`,
          )
        },
      },
    )
  }

  const filtersActive = Boolean(filters.model || filters.provider)
  const filtersSettled = modelFilter === debouncedModelFilter
    && providerFilter === debouncedProviderFilter
  const matchingCount = catalog.total
  const matchingLabel = !filtersSettled
    ? 'Filtering…'
    : matchingCount === undefined
      ? undefined
      : `${matchingCount} matching models`

  return (
    <SettingsPanel
      eyebrow={teamId ? 'Team' : 'Organization'}
      footer={
        <PaginationFooter
          canNext={catalog.canNext}
          canPrevious={catalog.canPrevious}
          label={catalog.label}
          onPageChange={catalog.onPageChange}
          onPageSizeChange={catalog.onPageSizeChange}
          page={catalog.page}
          pageCount={catalog.pageCount}
          pageSize={catalog.pageSize}
        />
      }
      tabs={tabs}
      title="Models"
    >
      <div className="grid gap-3">
        <FormError>{actionError}</FormError>
        <FormError>{catalogError}</FormError>
        <FormSuccess>{actionMessage}</FormSuccess>

        <ListToolbar
          count={matchingLabel}
          search={{
            label: 'Filter by model name',
            onChange: (value) => setFilter('model', value),
            placeholder: 'Model name contains…',
            value: modelFilter,
          }}
        >
          <div className="w-full max-w-xs">
            <Input
              aria-label="Filter by inference provider"
              onChange={(event) => setFilter('provider', event.target.value)}
              placeholder="Provider contains…"
              type="search"
              value={providerFilter}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="admin-button admin-button-secondary admin-button-compact"
              disabled={!filtersSettled || !matchingCount || setBulkEnabled.isPending}
              onClick={() => setBulkAction('enable')}
              type="button"
            >
              Enable all matches
            </button>
            <button
              className="admin-button admin-button-danger admin-button-compact"
              disabled={!filtersSettled || !matchingCount || setBulkEnabled.isPending}
              onClick={() => setBulkAction('disable')}
              type="button"
            >
              Disable all matches
            </button>
          </div>
        </ListToolbar>

        <DeploymentModelsTable
          emptyMessage={
            filtersActive
              ? 'No deployment models match these filters.'
              : 'The model service offers no chat models to this deployment.'
          }
          isLoading={catalog.query.isLoading}
          models={catalog.items}
          onTest={onTest}
          onToggle={onToggle}
          pendingPair={pendingPair}
          testingPair={testingPair}
          testResults={testResults}
          togglePending={setEnabled.isPending}
        />
      </div>
      <ConfirmDialog
        body={
          <p>
            This changes all {matchingCount ?? 0} matching models across the full catalogue,
            not only the rows on this page. Agents already using a disabled model keep running.
          </p>
        }
        confirmLabel={`${bulkAction === 'disable' ? 'Disable' : 'Enable'} all matches`}
        destructive={bulkAction === 'disable'}
        onCancel={() => setBulkAction(null)}
        onConfirm={onBulkConfirm}
        open={bulkAction !== null}
        pending={setBulkEnabled.isPending}
        title={`${bulkAction === 'disable' ? 'Disable' : 'Enable'} every matching model?`}
      />
    </SettingsPanel>
  )
}

export const OrganizationModelsPage = () => (
  <OrganizationAdministrationGate>
    <ModelAvailabilitySettings />
  </OrganizationAdministrationGate>
)
