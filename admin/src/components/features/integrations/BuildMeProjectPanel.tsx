import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  BuildMeProjectHandoffIntent,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { usePrepareBuildMeProjectHandoff } from '../../../facades/integrations/hooks'

const intentOptions: Array<{ label: string; value: BuildMeProjectHandoffIntent }> = [
  { label: 'Project definition', value: 'project_definition' },
  { label: 'Dev workspace', value: 'development_workspace' },
  { label: 'Board source', value: 'board_source_discovery' },
]

const readinessClass = (ready: boolean): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    ready
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : 'bg-[var(--warning-soft)] text-[var(--warning-text)]',
  ].join(' ')

const BoundaryRow = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded border border-[var(--sep)] px-3 py-2">
    <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">{label}</div>
    <div className="mt-1 text-sm leading-5 text-[var(--tx)]">{value}</div>
  </div>
)

export const BuildMeProjectPanel = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const navigate = useNavigate()
  const prepareHandoff = usePrepareBuildMeProjectHandoff()
  const [intent, setIntent] = useState<BuildMeProjectHandoffIntent>('project_definition')
  const [contextScope, setContextScope] = useState<'active_project' | 'active_team'>(
    'active_project',
  )
  const teamReady = product.teamEnablement?.enabled === true
  const accountReady = product.accountLink?.status === 'linked'
  const canSubmit = teamReady && accountReady && !prepareHandoff.isPending

  const submit = async () => {
    if (!canSubmit) return
    const response = await prepareHandoff.mutateAsync({
      contextScope,
      intent,
    })
    navigate(`/channels/${response.channel.id}`)
  }

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">buildme.live handoff</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={readinessClass(teamReady)}>
              {teamReady ? 'Team enabled' : 'Team disabled'}
            </span>
            <span className={readinessClass(accountReady)}>
              {accountReady ? 'UOA SSO linked' : 'SSO link pending'}
            </span>
            <span className={readinessClass(false)}>Board API pending</span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <div>
          <div className="mb-2 text-sm font-semibold text-[var(--tx2)]">Handoff</div>
          <div className="grid gap-2 md:grid-cols-3">
            {intentOptions.map((option) => (
              <button
                className={[
                  'h-9 rounded border px-2 text-xs font-semibold',
                  intent === option.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--thinking)]'
                    : 'border-[var(--sep)] text-[var(--tx2)] hover:bg-[var(--overlay)]',
                ].join(' ')}
                key={option.value}
                onClick={() => setIntent(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <label className="grid max-w-sm gap-1 text-sm">
          <span className="font-semibold text-[var(--tx2)]">Context scope</span>
          <select
            className="admin-input"
            onChange={(event) =>
              setContextScope(event.target.value as 'active_project' | 'active_team')
            }
            value={contextScope}
          >
            <option value="active_project">Active project</option>
            <option value="active_team">Active team</option>
          </select>
        </label>

        <div className="grid gap-2 md:grid-cols-3">
          <BoundaryRow label="Launch" value="Open buildme.live through UOA SSO." />
          <BoundaryRow label="Nessie data" value="Only active project/team context is referenced." />
          <BoundaryRow label="Board source" value="Read-only pairing waits for BuildMe API/MCP." />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sep)] pt-3">
        <div>
          {product.launchUrl ? (
            <a
              className="admin-button admin-button-secondary text-xs"
              href={product.launchUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open buildme.live
            </a>
          ) : null}
        </div>
        <button
          className="admin-button admin-button-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {prepareHandoff.isPending ? 'Preparing...' : 'Prepare handoff'}
        </button>
      </div>
      {prepareHandoff.isError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">
          {prepareHandoff.error instanceof Error
            ? prepareHandoff.error.message
            : 'Could not prepare buildme.live handoff.'}
        </p>
      ) : null}
    </section>
  )
}
