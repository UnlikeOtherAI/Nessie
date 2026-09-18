import { useState } from 'react'

import {
  DeploymentModelsTable,
  pairId,
} from '../../components/features/inference-models/DeploymentModelsTable'
import { FormError } from '../../components/shared/FormActions'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import {
  useDeploymentModelCatalog,
  useSetDeploymentModelEnabled,
  useTestDeploymentModel,
  type DeploymentModelRecord,
} from '../../facades/inference-models/hooks'

type TestOutcome = { latencyMs: number; message: string; ok: boolean }

/**
 * Every model this deployment can run, and whether this organisation allows it.
 *
 * The list is **Ledger's live catalogue**, not a local table: nothing in Nessie
 * enumerates "the models available in the deployment", so the page reads what
 * Ledger actually offers and folds the organisation's own decisions onto it. A
 * pair nobody has had an opinion about is available — that is the Ledger
 * default — and a catalogue that cannot be read says so instead of rendering a
 * list that may no longer be true.
 *
 * Switching a pair off is real rather than decorative: the Agent Designer's
 * picker stops offering it and every agent write path refuses a move onto it.
 * Agents already pinned to it keep running, which is why the row states how
 * many there are before anybody flips the switch.
 *
 * Personal model subscriptions are deliberately out of scope — an organisation
 * owner has no standing to enable, disable or spend a person's own consumer
 * plan (docs/standards/personal-model-subscriptions.md). The page copy says so
 * so the omission reads as a decision rather than a gap.
 */
const OrganizationModelsBody = () => {
  // A toggle or a test that failed silently would leave an owner believing the
  // deployment was in a state it is not — the one outcome this page must never
  // produce.
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingPair, setPendingPair] = useState<string | null>(null)
  const [testingPair, setTestingPair] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})

  const catalog = useDeploymentModelCatalog(true)
  const setEnabled = useSetDeploymentModelEnabled()
  const testModel = useTestDeploymentModel()

  const catalogError = catalog.query.isError
    ? catalog.query.error instanceof Error
      ? catalog.query.error.message
      : 'The model catalogue could not be read.'
    : null

  const onToggle = (model: DeploymentModelRecord, enabled: boolean) => {
    setActionError(null)
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

  return (
    <SettingsPanel
      eyebrow="Organization"
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
      subtitle={
        <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
          Every model this deployment can run, as the model service offers it today. Switch one
          off and nobody can select it for a new agent; agents already on it keep running, so
          the count beside each row says how many that would be. Test sends one short prompt and
          shows what came back — a real, billed inference call that appears in your token ledger.
          Personal subscriptions a member has linked to their own account are not governed here.
        </p>
      }
      title="Models"
    >
      <div className="grid gap-3">
        <FormError>{actionError}</FormError>
        <FormError>{catalogError}</FormError>

        <DeploymentModelsTable
          emptyMessage="The model service offers no chat models to this deployment."
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
    </SettingsPanel>
  )
}

export const OrganizationModelsPage = () => (
  <OrganizationAdministrationGate>
    <OrganizationModelsBody />
  </OrganizationAdministrationGate>
)
