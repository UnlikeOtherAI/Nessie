import { useState } from 'react'

import { CreateSecretDialog } from '../../components/features/settings/CreateSecretDialog'
import { SecretMetadataTable } from '../../components/features/settings/SecretMetadataTable'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { useProjects } from '../../facades/projects/hooks'
import {
  useCreateSecret,
  useRevokeSecret,
  useSecrets,
} from '../../facades/secrets/hooks'
import { FeedbackBanner, SettingsPanel, type SettingsFeedback } from './settings-shared'

export const SecretsPage = () => {
  const { data: secrets = [], isLoading } = useSecrets()
  const { data: projects = [] } = useProjects()
  const createSecret = useCreateSecret()
  const revokeSecret = useRevokeSecret()
  const [createOpen, setCreateOpen] = useState(false)
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)

  const revoke = async (reference: string) => {
    setFeedback(null)
    try {
      await revokeSecret.mutateAsync(reference)
      setFeedback({ kind: 'success', message: 'Secret revoked.' })
    } catch (caught) {
      setFeedback({ kind: 'error', message: caught instanceof Error ? caught.message : 'Could not revoke secret.' })
    }
  }

  return (
    <SettingsPanel
      actions={[
        {
          id: 'save-secret',
          label: 'Save a secret',
          onSelect: () => {
            setFeedback(null)
            setCreateOpen(true)
          },
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
      eyebrow="Security"
      title="Secrets"
    >
      <div className="grid max-w-5xl gap-4">
        <div className="grid gap-1">
          <p className="text-sm text-[color:var(--tx2)]">
            Keep credentials out of chat. Values go directly to Infisical and are never displayed here.
          </p>
          <p className="text-sm text-[color:var(--tx3)]">
            Copy a secret key or reference when you need to bind it elsewhere.
          </p>
        </div>
        <FeedbackBanner feedback={feedback} />
        <section className="admin-card overflow-hidden">
          <div className="border-b border-[color:var(--sep)] px-4 py-3">
            <h2 className="font-semibold text-[color:var(--tx)]">Available secrets</h2>
            <p className="mt-1 text-sm text-[color:var(--tx3)]">Values are intentionally never displayed.</p>
          </div>
          <SecretMetadataTable
            isLoading={isLoading}
            onRevoke={(reference) => void revoke(reference)}
            revokingReference={revokeSecret.isPending ? revokeSecret.variables : null}
            secrets={secrets}
          />
        </section>
      </div>
      <CreateSecretDialog
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => createSecret.mutateAsync(input)}
        onSaved={() => {
          setCreateOpen(false)
          setFeedback({ kind: 'success', message: 'Saved to the vault. Nessie retained only its metadata.' })
        }}
        open={createOpen}
        pending={createSecret.isPending}
        projects={projects}
      />
    </SettingsPanel>
  )
}
