import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { PairedAgentsTable } from '../../components/features/paired-agents/PairedAgentsTable'
import { FormError } from '../../components/shared/FormActions'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { SettingsPanel, type SettingsTabHostProps } from '../../components/shared/SettingsPanel'
import { createListPageStore } from '../../components/shared/list-page-state'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { OrganizationAdministrationGate } from './OrganizationAdministrationGate'
import {
  useOrgAgentAccessCredentials,
  useRevokeAgentAccessCredential,
} from '../../facades/agent-access/hooks'
import {
  SETTING_KEYS,
  settingFor,
  useScopedSettings,
  useWriteScopedSetting,
} from '../../facades/settings/hooks'
import { agentPairingAllowed } from '@nessie/schemas'

const orgPairedAgentsListStore = createListPageStore()

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
const OrganizationPairedAgentsBody = ({ host }: { host?: SettingsTabHostProps }) => {
  const navigate = useNavigate()
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

  const [initialState] = useState(orgPairedAgentsListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageRows = rows.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = rows.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, rows.length)

  useEffect(() => {
    orgPairedAgentsListStore.save({ page, pageSize })
  }, [page, pageSize])

  // Whether pairing is allowed at all is a standing rule, not an action you
  // fire, so it is the header's toggle rather than a checkbox in a card above
  // the list it governs.
  const actions: PageHeaderAction[] = [{
    checked: allowed,
    disabled: writeSetting.isPending,
    id: 'allow-pairing',
    kind: 'toggle',
    label: 'Allow pairing',
    onChange: (checked) => {
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
    },
    priority: 100,
  }]

  return (
    <SettingsPanel
      actions={actions}
      eyebrow="Organisation"
      host={host}
      footer={
        <PaginationFooter
          canNext={page < totalPages - 1}
          canPrevious={page > 0}
          label={rows.length === 0 ? 'Nothing paired' : `${rangeStart}–${rangeEnd} of ${rows.length}`}
          onPageChange={setRequestedPage}
          onPageSizeChange={(next) => {
            setPageSize(next)
            setRequestedPage(0)
          }}
          page={page}
          pageCount={totalPages}
          pageSize={pageSize}
        />
      }
      subtitle={
        <p className="max-w-3xl text-sm text-[color:var(--tx3)]">
          Pairing lets a member connect an outside agent — Claude Code, Codex, any MCP client —
          to their own account, which the agent then works as for ninety days.{' '}
          {allowed
            ? 'Members may pair outside agents today.'
            : 'Nobody can complete a new pairing. Credentials already issued keep working until '
              + 'they are revoked or expire — revoke them below if that is not what you want.'}
        </p>
      }
      title="Programs signed in as people"
    >
      <div className="grid gap-3">
        <FormError>{actionError}</FormError>

        <PairedAgentsTable
          credentials={pageRows}
          emptyMessage="Nothing paired. No member of this organisation has paired an outside agent."
          isLoading={credentials.isPending}
          onOpen={(credentialId) =>
            void navigate(`/admin/security/programs/${credentialId}`)}
          onRevoke={(credentialId) => {
            setActionError(null)
            revoke.mutate(credentialId, {
              onError: (error) =>
                setActionError(
                  error instanceof Error
                    ? error.message
                    : 'That credential could not be revoked. It is still live.',
                ),
            })
          }}
          revokePending={revoke.isPending}
          showOwner
        />
      </div>
    </SettingsPanel>
  )
}

export const OrganizationPairedAgentsPage = ({ host }: { host?: SettingsTabHostProps }) => (
  <OrganizationAdministrationGate host={host}>
    <OrganizationPairedAgentsBody host={host} />
  </OrganizationAdministrationGate>
)
