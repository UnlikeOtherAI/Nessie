import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { PairAgentDialog } from '../../components/features/paired-agents/PairAgentDialog'
import { PairedAgentsTable } from '../../components/features/paired-agents/PairedAgentsTable'
import { FormError } from '../../components/shared/FormActions'
import { PaginationFooter } from '../../components/shared/PaginationFooter'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { createListPageStore } from '../../components/shared/list-page-state'
import {
  useAgentAccessCredentials,
  useRevokeAgentAccessCredential,
} from '../../facades/agent-access/hooks'

const pairedAgentsListStore = createListPageStore()

/**
 * Paired agents — lending your account to a program, and taking it back.
 *
 * This page was called "Agent access" and could not be read. Four other
 * surfaces in this admin use "agent access" and "agents with access" to mean
 * *which of our own agents may reach this resource*; here it meant the inverse,
 * so a person arriving cold was primed for the wrong thing and found a code box
 * and an Approve button. The label was doing the damage, and the fix is to name
 * the interaction — you pair an agent, the way you pair a phone — and to name
 * the products doing the pairing, because "Claude Code, Codex" tells somebody
 * what this is faster than any abstract noun will.
 *
 * The form used to come first, which reads as "do this thing" before "here is
 * what this is" — and most arrivals never type anything anyway, because the
 * agent prints a link that carries the code. So the screen is now the list of
 * what you have lent out, and pairing is the dialog behind its one action.
 */
export const PairedAgentsPage = () => {
  const { t } = useTranslation('settings')
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const credentials = useAgentAccessCredentials()
  const revoke = useRevokeAgentAccessCredential()
  const [actionError, setActionError] = useState<string | null>(null)
  const [pairOpen, setPairOpen] = useState(false)

  // `?code=` is the agent's own verification link. It opens the pairing dialog
  // on the decision, and is stripped immediately: the code is single use, and
  // leaving it in the URL invites a reload that can only fail.
  const linkedCode = searchParams.get('code')
  useEffect(() => {
    if (!linkedCode) return
    setPairOpen(true)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('code')
      return next
    }, { replace: true })
  }, [linkedCode, setSearchParams])

  const rows = credentials.data?.credentials ?? []

  const [initialState] = useState(pairedAgentsListStore.load)
  const [pageSize, setPageSize] = useState(initialState.pageSize)
  const [requestedPage, setRequestedPage] = useState(initialState.page)

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const page = Math.min(requestedPage, totalPages - 1)
  const pageRows = rows.slice(page * pageSize, page * pageSize + pageSize)
  const rangeStart = rows.length === 0 ? 0 : page * pageSize + 1
  const rangeEnd = Math.min((page + 1) * pageSize, rows.length)

  useEffect(() => {
    pairedAgentsListStore.save({ page, pageSize })
  }, [page, pageSize])

  return (
    <SettingsPanel
      actions={[{
        icon: faPlus,
        id: 'pair-agent',
        label: t('pairedAgents.pair'),
        onSelect: () => setPairOpen(true),
        primary: true,
        priority: 100,
      }]}
      eyebrow={t('common.user')}
      footer={
        <PaginationFooter
          canNext={page < totalPages - 1}
          canPrevious={page > 0}
          label={rows.length === 0 ? t('pairedAgents.nothingPaired') : t('pairedAgents.range', { start: rangeStart, end: rangeEnd, count: rows.length })}
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
          {t('pairedAgents.description')}
        </p>
      }
      title={t('pairedAgents.title')}
    >
      <div className="grid gap-3">
        <FormError>{actionError}</FormError>

        <PairedAgentsTable
          credentials={pageRows}
          emptyMessage={t('pairedAgents.empty')}
          isLoading={credentials.isPending}
          onOpen={(credentialId) => void navigate(`/settings/paired-agents/${credentialId}`)}
          onRevoke={(credentialId) => {
            setActionError(null)
            revoke.mutate(credentialId, {
              onError: (error) =>
                setActionError(
                  error instanceof Error
                    ? error.message
                    : t('pairedAgents.revokeFailed'),
                ),
            })
          }}
          revokePending={revoke.isPending}
          showOwner={false}
        />
      </div>

      <PairAgentDialog
        {...(linkedCode ? { initialCode: linkedCode } : {})}
        onClose={() => setPairOpen(false)}
        open={pairOpen}
      />
    </SettingsPanel>
  )
}
