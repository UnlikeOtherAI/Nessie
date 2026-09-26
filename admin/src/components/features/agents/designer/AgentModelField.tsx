import { Link } from 'react-router-dom'
import type { AgentModelOption } from '../../../../lib/api-client'
import { FieldLabel } from '../../../primitives/FieldLabel'
import { ModelCombobox } from './ModelCombobox'
import { ModelUnavailableNotice } from './ModelUnavailableNotice'
import { LocalModelBindingApproval } from '../../local-inference/LocalModelBindingApproval'

type AgentModelFieldProps = {
  disabled: boolean
  agentId?: string
  error?: string
  loading: boolean
  model: string
  onSelect: (option: AgentModelOption) => void
  onLocalBindingChange: (bindingId: string | null) => void
  options: AgentModelOption[]
  provider: string
  selected: AgentModelOption | null
  streaming: boolean
}

/** The one model chooser used by the Model section for every agent surface. */
export const AgentModelField = ({
  agentId, disabled, error, loading, model, onLocalBindingChange, onSelect, options, provider, selected, streaming,
}: AgentModelFieldProps) => {
  const unavailable = Boolean((model || provider) && !selected)
  return (
    <div className="grid gap-1.5">
      <FieldLabel htmlFor="agent-model">Model</FieldLabel>
      <ModelCombobox
        disabled={loading || disabled}
        emptyLabel="No models match that search"
        highlighted={streaming}
        id="agent-model"
        onLinkSubscription={() => { window.open('/settings/accounts?tab=ai', '_blank', 'noopener,noreferrer') }}
        onSelect={onSelect}
        options={options}
        placeholder={loading ? 'Loading models…' : 'Search models…'}
        value={selected}
      />
      {unavailable ? <ModelUnavailableNotice model={model} /> : null}
      {selected ? (
        <p className="text-xs text-[color:var(--tx3)]">
          {selected.description ?? `Runs through ${selected.providerDisplayName}.`}
        </p>
      ) : null}
      {selected?.source === 'local' ? (
        <LocalModelBindingApproval
          agentId={agentId}
          disabled={disabled}
          key={`${selected.localInferenceHostId ?? 'none'}:${selected.localManifestDigest ?? 'none'}`}
          onBindingChange={onLocalBindingChange}
          option={selected}
        />
      ) : null}
      <p className="text-xs leading-5 text-[color:var(--tx3)]">
        To run this agent locally, connect Ollama on your own computer in{' '}
        <Link className="underline" to="/settings/accounts?tab=ai">Connected accounts</Link>.
        Local models never fall back to a cloud provider.
      </p>
      {error ? <p className="text-xs text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
    </div>
  )
}
