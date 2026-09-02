import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type {
  DeepTestReviewDepth,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { usePrepareDeepTestReview } from '../../../facades/integrations/hooks'
import { Notice } from '../../primitives/Notice'
import { Pill, type PillTone } from '../../primitives/Pill'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { FormField } from '../../shared/FormField'
import { Select } from '../../shared/FormControls'
import { KeyValueList } from '../../shared/KeyValueList'
import { appsHref } from './AgentConnectorSection'

const depthOptions: Array<{ label: string; value: DeepTestReviewDepth }> = [
  { label: 'Shallow', value: 'shallow' },
  { label: 'Standard', value: 'standard' },
  { label: 'Deep', value: 'deep' },
  { label: 'Overnight', value: 'overnight' },
]

const readinessTone = (ready: boolean): PillTone => (ready ? 'success' : 'warning')

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
    <section className="border-t border-[color:var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">DeepTest security review</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill
              className="font-semibold"
              radius="chip"
              size="sm"
              tone={readinessTone(teamReady)}
              uppercase={false}
            >
              {teamReady ? 'Team enabled' : 'Team disabled'}
            </Pill>
            <Pill
              className="font-semibold"
              radius="chip"
              size="sm"
              tone={readinessTone(connectorReady)}
              uppercase={false}
            >
              {connectorReady ? 'Local MCP active' : 'Local MCP setup required'}
            </Pill>
            <Pill
              className="font-semibold"
              radius="chip"
              size="sm"
              tone={readinessTone(product.accountLink?.status === 'linked')}
              uppercase={false}
            >
              {product.accountLink?.status === 'linked' ? 'Account linked' : 'Account pending'}
            </Pill>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <ChoiceGroup
          label="Depth"
          onChange={setDepth}
          options={depthOptions}
          value={depth}
        />

        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Runner">
            <Select
              onChange={(event) => setRunner(event.target.value as typeof runner)}
              value={runner}
            >
              <option value="local_mcp">Local MCP runner</option>
              <option value="private_runner">Private runner</option>
            </Select>
          </FormField>
          <FormField label="Report handoff">
            <Select
              onChange={(event) => setArtifactPolicy(event.target.value as typeof artifactPolicy)}
              value={artifactPolicy}
            >
              <option value="share_safe_report">Share-safe report only</option>
              <option value="external_link_only">External link only</option>
            </Select>
          </FormField>
        </div>

        <KeyValueList
          items={[
            { label: 'Target material', value: 'Configured inside DeepTest, not Nessie.' },
            { label: 'Agent tool', value: 'deeptest_review through approved MCP only.' },
            { label: 'Imports', value: 'Share-safe output or external link only.' },
          ]}
          layout="grid"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--sep)] pt-3">
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
            <Link className="admin-button admin-button-secondary admin-button-compact" to={appsHref(product)}>
              Connect app
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
        <Notice className="mt-2" role="alert" size="sm" tone="danger">
          {prepareReview.error instanceof Error
            ? prepareReview.error.message
            : 'Could not prepare DeepTest review.'}
        </Notice>
      ) : null}
    </section>
  )
}
