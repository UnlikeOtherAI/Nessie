import type { AgentTriggerRecord } from '../../../lib/api-client'
import { fieldLabelClass } from './trigger-config'

type WebhookTriggerFieldsProps = {
  mode: 'create' | 'edit'
  trigger?: AgentTriggerRecord
  webhookUrl: string
}

export const WebhookTriggerFields = ({
  mode,
  trigger,
  webhookUrl,
}: WebhookTriggerFieldsProps) => (
  <section className="rounded-xl border border-[color:var(--sep)] bg-black/10 p-4">
    <div className="grid gap-4 md:grid-cols-2">
      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="trigger-webhook-endpoint">
          Shared endpoint
        </label>
        <input
          className="admin-input cursor-default font-mono text-xs opacity-80"
          disabled
          id="trigger-webhook-endpoint"
          value={webhookUrl}
        />
      </div>

      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-webhook-auth-header">
          Auth header
        </label>
        <input
          className="admin-input cursor-default font-mono text-xs opacity-80"
          disabled
          id="trigger-webhook-auth-header"
          value="Authorization: Bearer <api-key>"
        />
      </div>

      <div className="grid gap-1.5">
        <label className={fieldLabelClass} htmlFor="trigger-webhook-fallback-header">
          Alternate header
        </label>
        <input
          className="admin-input cursor-default font-mono text-xs opacity-80"
          disabled
          id="trigger-webhook-fallback-header"
          value="X-Nessie-Trigger-Key: <api-key>"
        />
      </div>

      <div className="grid gap-1.5 md:col-span-2">
        <label className={fieldLabelClass} htmlFor="trigger-webhook-api-key">
          API key
        </label>
        <input
          className="admin-input cursor-default font-mono text-xs opacity-80"
          disabled
          id="trigger-webhook-api-key"
          value={
            trigger?.webhookApiKey ??
            (mode === 'create'
              ? 'Generated automatically after creation'
              : 'Save this trigger to generate an API key')
          }
        />
      </div>
    </div>

    <div className="mt-4 rounded-xl border border-[color:var(--sep)] bg-black/10 px-3 py-3 text-sm text-[color:var(--tx3)]">
      Nessie routes every webhook call through this single endpoint and uses the
      trigger API key to identify which trigger should fire.
    </div>
  </section>
)
