import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type {
  DeepTestReviewDepth,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { usePrepareDeepTestReview } from '../../../facades/integrations/hooks'
import { mcpInstallHref } from './AgentConnectorSection'

const depthOptions: Array<{ label: string; value: DeepTestReviewDepth }> = [
  { label: 'Shallow', value: 'shallow' },
  { label: 'Standard', value: 'standard' },
  { label: 'Deep', value: 'deep' },
  { label: 'Overnight', value: 'overnight' },
]

const readinessClass = (ready: boolean): string =>
  [
    'rounded px-2 py-0.5 text-[11px] font-semibold',
    ready
      ? 'bg-[var(--success-soft)] text-[var(--success-text)]'
      : 'bg-[var(--warning-soft)] text-[var(--warning-text)]',
  ].join(' ')

const PrivacyRow = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded border border-[var(--sep)] px-3 py-2">
    <div className="text-[11px] font-semibold uppercase text-[var(--tx3)]">{label}</div>
    <div className="mt-1 text-sm leading-5 text-[var(--tx)]">{value}</div>
  </div>
)

export const DeepTestSecurityPanel = ({
  product,
}: {
  product: IntegratedProductResponse
}) => {
  const navigate = useNavigate()
  const prepareReview = usePrepareDeepTestReview()
  const [depth, setDepth] = useState<DeepTestReviewDepth>('standard')
  const [artifactPolicy, setArtifactPolicy] = useState<'share_safe_report' | 'external_link_only'>(
    'share_safe_report',
  )
  const [runner, setRunner] = useState<'local_mcp' | 'private_runner'>('local_mcp')
  const teamReady = product.teamEnablement?.enabled === true
  const connectorReady = product.mcpInstallation?.lifecycleState === 'active'
  const ready = teamReady && connectorReady
  const canSubmit = ready && !prepareReview.isPending

  const submit = async () => {
    if (!canSubmit) return
    const response = await prepareReview.mutateAsync({
      artifactPolicy,
      depth,
      runner,
    })
    navigate(`/channels/${response.channel.id}`)
  }

  return (
    <section className="border-t border-[var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--tx)]">DeepTest security review</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <span className={readinessClass(teamReady)}>
              {teamReady ? 'Team enabled' : 'Team disabled'}
            </span>
            <span className={readinessClass(connectorReady)}>
              {connectorReady ? 'Local MCP active' : 'Local MCP setup required'}
            </span>
            <span className={readinessClass(product.accountLink?.status === 'linked')}>
              {product.accountLink?.status === 'linked' ? 'Account linked' : 'Account pending'}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <div>
          <div className="mb-2 text-sm font-semibold text-[var(--tx2)]">Depth</div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {depthOptions.map((option) => (
              <button
                className={[
                  'h-9 rounded border px-2 text-xs font-semibold',
                  depth === option.value
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--thinking)]'
                    : 'border-[var(--sep)] text-[var(--tx2)] hover:bg-[var(--overlay)]',
                ].join(' ')}
                key={option.value}
                onClick={() => setDepth(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Runner</span>
            <select
              className="admin-input"
              onChange={(event) => setRunner(event.target.value as typeof runner)}
              value={runner}
            >
              <option value="local_mcp">Local MCP runner</option>
              <option value="private_runner">Private runner</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            <span className="font-semibold text-[var(--tx2)]">Report handoff</span>
            <select
              className="admin-input"
              onChange={(event) => setArtifactPolicy(event.target.value as typeof artifactPolicy)}
              value={artifactPolicy}
            >
              <option value="share_safe_report">Share-safe report only</option>
              <option value="external_link_only">External link only</option>
            </select>
          </label>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <PrivacyRow label="Target material" value="Configured inside DeepTest, not Nessie." />
          <PrivacyRow label="Agent tool" value="deeptest_review through approved MCP only." />
          <PrivacyRow label="Imports" value="Share-safe output or external link only." />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--sep)] pt-3">
        <div className="flex flex-wrap gap-2">
          {product.launchUrl ? (
            <a
              className="admin-button admin-button-secondary admin-button-compact"
              href={product.launchUrl}
              rel="noreferrer"
              target="_blank"
            >
              Open DeepTest
            </a>
          ) : null}
          {!connectorReady ? (
            <Link className="admin-button admin-button-secondary admin-button-compact" to={mcpInstallHref(product)}>
              Install MCP
            </Link>
          ) : null}
        </div>
        <button
          className="admin-button admin-button-primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
          type="button"
        >
          {prepareReview.isPending ? 'Preparing...' : 'Prepare review'}
        </button>
      </div>
      {prepareReview.isError ? (
        <p className="mt-2 text-xs text-[var(--danger-text)]">
          {prepareReview.error instanceof Error
            ? prepareReview.error.message
            : 'Could not prepare DeepTest review.'}
        </p>
      ) : null}
    </section>
  )
}
