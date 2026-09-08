import { useState } from 'react'

import { Card } from '../../components/shared/Card'
import { EmptyState } from '../../components/shared/EmptyState'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { Checkbox } from '../../components/primitives/Checkbox'
import { Pill } from '../../components/primitives/Pill'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import {
  useOrgAgentAccessCredentials,
  useRevokeAgentAccessCredential,
  type AgentAccessScope,
} from '../../facades/agent-access/hooks'
import {
  SETTING_KEYS,
  settingFor,
  useScopedSettings,
  useWriteScopedSetting,
} from '../../facades/settings/hooks'
import { agentPairingAllowed } from '@nessie/schemas'

/**
 * Every paired agent in the organisation, and whether pairing happens at all.
 *
 * This surface exists because the personal one is deliberately self-only, and
 * that left a real hole: any member could hand a ninety-day credential that
 * acts as them to an arbitrary program, and nobody accountable for the
 * organisation had a list of those, a way to end one, or a way to say no. A
 * product that ships an Audit log and a Policy page cannot also ship that.
 *
 * It is a governance view, not a management one. It shows that a credential
 * exists, whose account it borrows, what it can reach and whether it is live —
 * and it can revoke. It deliberately does not show token prefixes: an owner
 * needs to end somebody's credential, not to tell two of them apart.
 */

const SCOPE_LABEL: Record<AgentAccessScope, string> = {
  boards_read: 'read boards',
  boards_write: 'change boards',
  documents_read: 'read documents',
  documents_write: 'draft documents',
}

const formatDate = (value: string): string =>
  new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })

const OrganizationPairedAgentsBody = () => {
  // A revoke or a switch that silently failed would leave an owner believing
  // they had ended access they had not, which is the one outcome this surface
  // must never produce.
  const [actionError, setActionError] = useState<string | null>(null)
  const credentials = useOrgAgentAccessCredentials(true)
  const revoke = useRevokeAgentAccessCredential()
  const settings = useScopedSettings('organization', [SETTING_KEYS.agentPairing])
  const writeSetting = useWriteScopedSetting()

  const setting = settingFor(settings.data, SETTING_KEYS.agentPairing)
  const allowed = agentPairingAllowed(setting?.value)

  const rows = credentials.data?.credentials ?? []
  const live = rows.filter(
    (row) => row.revokedAt === null && new Date(row.expiresAt).getTime() > Date.now(),
  )

  return (
    <div className="grid max-w-3xl gap-5">
      <Card>
        <SectionLabel>Pairing</SectionLabel>
        <p className="mt-1 text-sm text-[color:var(--tx2)]">
          Pairing lets a member connect an outside agent — Claude Code, Codex, any
          MCP client — to their own account. The agent then works with exactly that
          person&rsquo;s access for ninety days, until they revoke it.
        </p>
        <div className="mt-3">
          <Checkbox
            checked={allowed}
            description={
              allowed
                ? 'Members may pair outside agents with their own accounts.'
                : 'Nobody in this organisation can complete a new pairing. Credentials '
                  + 'already issued keep working until they are revoked or expire — '
                  + 'revoke them below if that is not what you want.'
            }
            disabled={writeSetting.isPending}
            label="Allow members to pair outside agents"
            onChange={(checked) => {
              setActionError(null)
              writeSetting.mutate({
                key: SETTING_KEYS.agentPairing,
                // Locked whenever the organisation says no: an organisation-level
                // "off" that a team or a person could override is not an answer.
                locked: !checked,
                scope: 'organization',
                value: { allowed: checked },
              }, {
                onError: (error) =>
                  setActionError(
                    error instanceof Error
                      ? error.message
                      : 'That setting could not be saved. Nothing changed.',
                  ),
              })
            }}
          />
        </div>
        {actionError ? (
          <p className="mt-3 text-sm text-[color:var(--danger-text)]">{actionError}</p>
        ) : null}
      </Card>

      <Card>
        <SectionLabel>
          {live.length > 0 ? `Paired agents (${live.length} live)` : 'Paired agents'}
        </SectionLabel>
        {credentials.isLoading ? (
          <p className="mt-2 text-sm text-[color:var(--tx3)]">Loading…</p>
        ) : rows.length === 0 ? (
          <div className="mt-2">
            <EmptyState title="Nothing paired">
              No member of this organisation has paired an outside agent.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-2 grid gap-2">
            {rows.map((credential) => {
              const expired = new Date(credential.expiresAt).getTime() <= Date.now()
              const dead = credential.revokedAt !== null || expired
              return (
                <div
                  className="flex items-start justify-between gap-3 rounded-lg border border-[var(--bd)] p-3"
                  key={credential.id}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-[var(--tx)]">
                        {credential.label}
                      </span>
                      <Pill tone={dead ? 'muted' : 'success'}>
                        {credential.revokedAt ? 'revoked' : expired ? 'expired' : 'active'}
                      </Pill>
                    </div>
                    <div className="mt-0.5 text-xs text-[color:var(--tx2)]">
                      {`Works as ${credential.user.displayName} (${credential.user.email})`}
                    </div>
                    <div className="mt-0.5 text-xs text-[color:var(--tx3)]">
                      {credential.scopes.length > 0
                        ? `Can ${credential.scopes.map((scope) => SCOPE_LABEL[scope]).join(', ')}`
                        : 'Nothing granted'}
                      {` · paired ${formatDate(credential.createdAt)}`}
                      {credential.revokedAt
                        ? ` · revoked ${formatDate(credential.revokedAt)}`
                        : ` · ${expired ? 'expired' : 'expires'} ${formatDate(credential.expiresAt)}`}
                      {credential.lastUsedAt
                        ? ` · last used ${formatDate(credential.lastUsedAt)}`
                        : ' · never used'}
                    </div>
                  </div>
                  {dead ? null : (
                    <button
                      className="admin-button admin-button-secondary flex-shrink-0"
                      disabled={revoke.isPending}
                      onClick={() => {
                        setActionError(null)
                        revoke.mutate(credential.id, {
                          onError: (error) =>
                            setActionError(
                              error instanceof Error
                                ? error.message
                                : 'That credential could not be revoked. It is still live.',
                            ),
                        })
                      }}
                      type="button"
                    >
                      Revoke
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {actionError ? (
          <p className="mt-3 text-sm text-[color:var(--danger-text)]">{actionError}</p>
        ) : null}
      </Card>
    </div>
  )
}

export const OrganizationPairedAgentsPage = () => (
  <OrganizationAdministrationGate>
    <SettingsPanel eyebrow="Organization" title="Paired agents">
      <OrganizationPairedAgentsBody />
    </SettingsPanel>
  </OrganizationAdministrationGate>
)
