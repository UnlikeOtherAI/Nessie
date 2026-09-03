import { useState } from 'react'

import { CreateSecretDialog } from '../../components/features/settings/CreateSecretDialog'
import { SecretMetadataTable } from '../../components/features/settings/SecretMetadataTable'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { useProjects } from '../../facades/projects/hooks'
import {
  useCreateSecret,
  useRevokeSecret,
  useSecrets,
} from '../../facades/secrets/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { FeedbackBanner, SettingsPanel, type SettingsFeedback } from './settings-shared'

export const SecretsPage = () => {
  const { data: secrets = [], isLoading } = useSecrets()
  const { data: projects = [] } = useProjects()
  const { me } = useAuthSession()
  const precedenceContext = {
    userId: me?.user.id ?? '',
    teamId: me?.context.teamId ?? '',
    projectId: me?.context.projectId ?? '',
  }
  const createSecret = useCreateSecret()
  const revokeSecret = useRevokeSecret()
  const [createOpen, setCreateOpen] = useState(false)
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null)

  const revoke = async (reference: string) => {
    setFeedback(null)
    try {
      await revokeSecret.mutateAsync(reference)
      setFeedback({ kind: 'success', message: 'Secret revoked.' })
      setPendingRevoke(null)
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
      <div className="grid gap-4">
        <div className="grid gap-1">
          <p className="text-sm text-[color:var(--tx2)]">
            Keep credentials out of chat. Values go directly to Infisical and are never displayed here.
          </p>
          <p className="text-sm text-[color:var(--tx3)]">
            Copy a secret key or reference when you need to bind it elsewhere.
          </p>
          <p className="text-sm text-[color:var(--tx3)]">
            A secret with the same key at a narrower scope overrides a broader
            one — personal beats project, project beats team, team beats
            organisation. The Precedence column shows which one currently
            applies to you.
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
            onRevoke={(reference) => setPendingRevoke(reference)}
            precedenceContext={precedenceContext}
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
      <ConfirmDialog
        body="Anything still using this secret reference will stop working."
        confirmLabel="Revoke secret"
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) void revoke(pendingRevoke)
        }}
        open={pendingRevoke != null}
        pending={revokeSecret.isPending}
        title="Revoke this secret?"
      />
    </SettingsPanel>
  )
}
