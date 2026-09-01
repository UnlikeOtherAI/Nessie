import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Switch } from '../../../components/primitives/Switch'

type ConversationalSetupPanelProps = {
  enabled: boolean
  error: string | null
  onChange: (enabled: boolean) => void
  pending: boolean
}

/** Owner-only organization control for the narrow conversational setup gate. */
export const ConversationalSetupPanel = ({
  enabled,
  error,
  onChange,
  pending,
}: ConversationalSetupPanelProps) => (
  <section className="admin-card p-4" id="early-access">
    <SectionLabel>Early access</SectionLabel>
    <div className="mt-4 flex items-start justify-between gap-4">
      <div className="max-w-xl">
        <h2 className="font-semibold text-[color:var(--tx)]">Conversational agent setup</h2>
        <p className="mt-1 text-sm text-[color:var(--tx2)]">
          Allow this organisation to use the conversational setup journey as it becomes
          available. Enabling it never installs an app, signs in to a service, or grants an
          agent access without a person’s explicit action.
        </p>
      </div>
      <Switch
        checked={enabled}
        disabled={pending}
        label="Enable conversational agent setup"
        onChange={onChange}
      />
    </div>
    {error ? <p className="mt-3 text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
  </section>
)
