import type { DeploymentModelRecord } from '../../../facades/inference-models/hooks'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { Switch } from '../../primitives/Switch'
import { ExpandableTable } from '../../shared/ExpandableTable'

/**
 * Every model this deployment can run, and whether this organisation allows it.
 *
 * One row is one Ledger provider/model pair. The switch is the decision the row
 * exists for; the agent count beside it is what makes that decision safe to
 * make, because switching off a pair three agents are pinned to is a different
 * act from switching off one nobody uses. Test is the second decision — "does
 * this actually answer?" — and its result renders in the row that produced it.
 */

export type DeploymentModelsTableProps = {
  emptyMessage: string
  isLoading: boolean
  models: DeploymentModelRecord[]
  onTest: (model: DeploymentModelRecord) => void
  onToggle: (model: DeploymentModelRecord, enabled: boolean) => void
  pendingPair: string | null
  /** The last test result, keyed `provider/model`, rendered in its own row. */
  testResults: Record<string, { latencyMs: number; message: string; ok: boolean }>
  testingPair: string | null
  togglePending: boolean
}

const SKELETON_ROWS = 6

export const pairId = (model: { model: string; provider: string }): string =>
  `${model.provider}/${model.model}`

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Deployment models table"
  >
    <table className="admin-table w-full border-collapse">{children}</table>
  </ExpandableTable>
)

const headerClass = [
  'px-3 py-2 text-left text-[11px] font-semibold uppercase',
  'tracking-[0.12em] text-[color:var(--tx3)]',
].join(' ')

const COLUMN_COUNT = 5

const header = (
  <thead>
    <tr className="border-b border-[color:var(--sep)]">
      <th className={`${headerClass} pl-4`} scope="col">Model</th>
      <th className={`${headerClass} hidden md:table-cell`} scope="col">Provider</th>
      <th className={headerClass} scope="col">In use</th>
      <th className={headerClass} scope="col">Test</th>
      <th className={headerClass} scope="col">Available</th>
    </tr>
  </thead>
)

export const DeploymentModelsTable = ({
  emptyMessage,
  isLoading,
  models,
  onTest,
  onToggle,
  pendingPair,
  testResults,
  testingPair,
  togglePending,
}: DeploymentModelsTableProps) => {
  if (isLoading) {
    return (
      <TableFrame>
        {header}
        <tbody>
          <tr>
            <td className="px-4 py-4" colSpan={COLUMN_COUNT}>
              <Skeleton count={SKELETON_ROWS} variant="list" />
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  if (models.length === 0) {
    return (
      <TableFrame>
        {header}
        <tbody>
          <tr>
            <td
              className="px-4 py-12 text-center text-sm text-[color:var(--tx3)]"
              colSpan={COLUMN_COUNT}
            >
              {emptyMessage}
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  return (
    <TableFrame>
      {header}
      <tbody>
        {models.map((model) => {
          const id = pairId(model)
          const result = testResults[id]
          return (
            <tr key={id}>
              <td className="min-w-0 py-2.5 pl-4 pr-3 align-middle">
                <div className="truncate text-sm font-medium text-[color:var(--tx)]">
                  {model.displayName}
                </div>
                <div className="truncate font-mono text-xs text-[color:var(--tx3)]">
                  {model.model}
                </div>
                {result ? (
                  <div
                    className={[
                      'mt-1 text-xs',
                      result.ok
                        ? 'text-[color:var(--tx2)]'
                        : 'text-[color:var(--danger-text)]',
                    ].join(' ')}
                    role="status"
                  >
                    {result.ok ? `Answered in ${result.latencyMs} ms — ` : 'Did not answer — '}
                    {result.message}
                  </div>
                ) : null}
              </td>
              <td className="hidden w-48 px-3 py-2.5 align-middle text-xs text-[color:var(--tx2)] md:table-cell">
                {model.providerDisplayName}
              </td>
              <td className="w-28 px-3 py-2.5 align-middle">
                {/* Nothing shows a zero: a pair nobody uses says nothing rather
                    than "0 agents", so the column reads as a list of the rows
                    that need care before a switch is flipped. */}
                {model.agentCount > 0 ? (
                  <Pill height="control" tone="info" uppercase={false}>
                    {model.agentCount === 1 ? '1 agent' : `${model.agentCount} agents`}
                  </Pill>
                ) : null}
              </td>
              <td className="w-24 px-3 py-2.5 align-middle">
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={testingPair !== null}
                  onClick={() => onTest(model)}
                  type="button"
                >
                  {testingPair === id ? 'Testing…' : 'Test'}
                </button>
              </td>
              <td className="w-28 px-3 py-2.5 align-middle">
                <Switch
                  checked={model.enabled}
                  disabled={togglePending && pendingPair === id}
                  label={`${model.enabled ? 'Disable' : 'Enable'} ${model.displayName}`}
                  onChange={(next) => onToggle(model, next)}
                />
              </td>
            </tr>
          )
        })}
      </tbody>
    </TableFrame>
  )
}
