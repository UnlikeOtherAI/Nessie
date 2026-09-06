import { useState } from 'react'

import { CreateSecretDialog } from '../../components/features/settings/CreateSecretDialog'
import {
  SecretMetadataTable,
  type SecretPageScope,
  type SecretsTab,
} from '../../components/features/settings/SecretMetadataTable'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { TabBar, type TabBarItem } from '../../components/primitives/TabBar'
import { useProjects } from '../../facades/projects/hooks'
import {
  useCreateSecret,
  useRevokeSecret,
  useSecrets,
} from '../../facades/secrets/hooks'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { useTabParam } from '../../navigation/useTabParam'
import { FeedbackBanner, type SettingsFeedback } from './FeedbackBanner'
import { SettingsPanel } from '../../components/shared/SettingsPanel'

const SECRETS_TABS = ['active', 'revoked'] as const

const TABS: ReadonlyArray<TabBarItem<SecretsTab>> = [
  { label: 'Active', value: 'active' },
  { label: 'Revoked', value: 'revoked' },
]

type SecretsPanelCopy = {
  cascade: string
  eyebrow: string
  intro: string
}

/**
 * One page per level, each saying what its own level is rather than restating
 * the whole cascade three times. The eyebrow is the nav group the page lives
 * in (`User`, `Team`, `Organization`), so the three read as one family.
 */
const COPY: Record<SecretPageScope, SecretsPanelCopy> = {
  organization: {
    cascade: 'A team or a person can save their own secret with the same key and theirs wins — '
      + 'unless this one is locked, in which case theirs is refused and this one applies everywhere.',
    eyebrow: 'Organization',
    intro: 'The company\'s credentials. Every team and every person inherits these unless they '
      + 'save their own under the same key.',
  },
  personal: {
    cascade: 'Your own secret beats your project\'s, which beats your team\'s, which beats the '
      + 'organisation\'s. A key locked at a level above cannot be overridden, and is greyed out here.',
    eyebrow: 'User',
    intro: 'Everything that reaches you: your own secrets, plus what your team and organisation set.',
  },
  team: {
    cascade: 'A team secret beats the organisation\'s, and a person\'s own beats both — unless a '
      + 'key is locked, which pins it for everybody below and greys it out there.',
    eyebrow: 'Team',
    intro: 'What this team\'s work runs on: the team\'s own secrets, plus what the organisation set.',
  },
}

type SecretsPanelProps = { scope: SecretPageScope }

/**
 * The single Secrets page, used at personal, team and organisation scope — the
 * same shape `MembersRosterPanel` takes for its two rosters, down to the tab
 * strip and the bare table under it. The three differ only in which rows they
 * show, which scope "New secret" writes into, and whether a Scope column earns
 * its place.
 */
export const SecretsPanel = ({ scope }: SecretsPanelProps) => {
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
  const [tab, setTab] = useTabParam<SecretsTab>('tab', SECRETS_TABS, 'active')
  const [createOpen, setCreateOpen] = useState(false)
  const [feedback, setFeedback] = useState<SettingsFeedback | null>(null)
  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null)
  const copy = COPY[scope]
  // The level this page writes into. Personal needs none — the API binds a
  // personal secret to the caller — and a project secret names its own.
  const pageScopeId = scope === 'team'
    ? me?.context.teamId ?? ''
    : scope === 'organization'
      ? me?.context.organizationId ?? ''
      : ''

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
          id: 'new-secret',
          label: 'New secret',
          onSelect: () => {
            setFeedback(null)
            setCreateOpen(true)
          },
          primary: true,
          priority: 100,
        } satisfies PageHeaderAction,
      ]}
      eyebrow={copy.eyebrow}
      title="Secrets"
    >
      <div className="space-y-5">
        <div className="grid gap-1">
          <p className="text-sm text-[color:var(--tx2)]">{copy.intro}</p>
          <p className="text-sm text-[color:var(--tx3)]">
            Values go directly to Infisical and are never displayed here. Copy a secret key or
            reference when you need to bind it elsewhere.
          </p>
          <p className="text-sm text-[color:var(--tx3)]">{copy.cascade}</p>
        </div>
        <FeedbackBanner feedback={feedback} />
        <TabBar
          ariaLabel="Secret status"
          idPrefix={`secrets-${scope}`}
          items={TABS}
          onChange={setTab}
          value={tab}
        />
        {/* The table owns its own frame and is never wrapped in a card
            (docs/standards/design-system.md → no nesting), which is also what
            gives the empty state room to breathe rather than pinning it to a
            card's inner edge. */}
        <section
          aria-labelledby={`secrets-${scope}-tab-${tab}`}
          id={`secrets-${scope}-tabpanel-${tab}`}
          role="tabpanel"
        >
          <SecretMetadataTable
            isLoading={isLoading}
            onRevoke={(reference) => setPendingRevoke(reference)}
            pageScope={scope}
            precedenceContext={precedenceContext}
            revokingReference={revokeSecret.isPending ? revokeSecret.variables : null}
            secrets={secrets}
            tab={tab}
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
        pageScope={scope}
        pending={createSecret.isPending}
        projects={projects}
        scopeId={pageScopeId}
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
