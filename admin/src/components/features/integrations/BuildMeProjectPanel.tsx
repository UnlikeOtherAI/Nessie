import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  BuildMeProjectHandoffIntent,
  IntegratedProductResponse,
} from '../../../lib/api-client'
import { usePrepareBuildMeProjectHandoff } from '../../../facades/integrations/hooks'
import { Pill, type PillTone } from '../../primitives/Pill'
import { ChoiceGroup } from '../../shared/ChoiceGroup'
import { FormField } from '../../shared/FormField'
import { Select } from '../../shared/FormControls'
import { KeyValueList } from '../../shared/KeyValueList'
import { Notice } from '../../primitives/Notice'

const intentOptions: Array<{ label: string; value: BuildMeProjectHandoffIntent }> = [
  { label: 'Project definition', value: 'project_definition' },
  { label: 'Dev team', value: 'development_workspace' },
  { label: 'Board source', value: 'board_source_discovery' },
]

const readinessTone = (ready: boolean): PillTone => (ready ? 'success' : 'warning')

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
    <section className="border-t border-[color:var(--sep)] pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[color:var(--tx)]">buildme.live handoff</h3>
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
              tone={readinessTone(accountReady)}
              uppercase={false}
            >
              {accountReady ? 'UOA SSO linked' : 'SSO link pending'}
            </Pill>
            <Pill
              className="font-semibold"
              radius="chip"
              size="sm"
              tone={readinessTone(false)}
              uppercase={false}
            >
              Board API pending
            </Pill>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-3">
        <ChoiceGroup
          label="Handoff"
          onChange={setIntent}
          options={intentOptions}
          value={intent}
        />

        <FormField className="max-w-sm" label="Context scope">
          <Select
            onChange={(event) =>
              setContextScope(event.target.value as 'active_project' | 'active_team')
            }
            value={contextScope}
          >
            <option value="active_project">Active project</option>
            <option value="active_team">Active team</option>
          </Select>
        </FormField>

        <KeyValueList
          items={[
            { label: 'Launch', value: 'Open buildme.live through UOA SSO.' },
            { label: 'Nessie data', value: 'Only active project/team context is referenced.' },
            { label: 'Board source', value: 'Read-only pairing waits for BuildMe API/MCP.' },
          ]}
          layout="grid"
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--sep)] pt-3">
        <div>
          {product.launchUrl ? (
            <a
              className="admin-button admin-button-secondary admin-button-compact"
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
        <Notice className="mt-2" role="alert" size="sm" tone="danger">
          {prepareHandoff.error instanceof Error
            ? prepareHandoff.error.message
            : 'Could not prepare buildme.live handoff.'}
        </Notice>
      ) : null}
    </section>
  )
}
