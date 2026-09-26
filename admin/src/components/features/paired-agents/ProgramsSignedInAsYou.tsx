import { useEffect, useState } from 'react'
import { faPlus } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useNavigate } from 'react-router-dom'

import { FormError } from '../../shared/FormActions'
import { Section } from '../../shared/PageBody'
import { PaginationFooter } from '../../shared/PaginationFooter'
import { createListPageStore } from '../../shared/list-page-state'
import {
  useAgentAccessCredentials,
  useRevokeAgentAccessCredential,
} from '../../../facades/agent-access/hooks'
import { useConsumedIntent } from '../../../navigation/intent'
import { PairAgentDialog } from './PairAgentDialog'
import { PairedAgentsTable } from './PairedAgentsTable'

const pairedAgentsListStore = createListPageStore()

/**
 * Programs signed in as you — lending your account to a program, and taking
 * it back. A section of Security, beside the sessions and the password, because
 * a paired program is one more thing that holds your login.
 *
 * It was a page called "Agent access" and could not be read: four other
 * surfaces use "agent access" to mean *which of our own agents may reach this
 * resource*, and here it meant the inverse. So it names the interaction — you
 * pair a program, the way you pair a phone — and the products doing the
 * pairing, because "Claude Code, Codex" says what this is faster than any
 * abstract noun will.
 *
 * The list leads and pairing is the dialog behind its one action: most arrivals
 * never type anything, because the program prints a link that carries the code.
 */
export const ProgramsSignedInAsYou = () => {
  const navigate = useNavigate()
  const credentials = useAgentAccessCredentials()
  const revoke = useRevokeAgentAccessCredential()
  const [actionError, setActionError] = useState<string | null>(null)
  const [pairOpen, setPairOpen] = useState(false)

  // `?code=` is the program's own verification link, a consumed intent of
  // `/settings/security`. It opens the pairing dialog on the decision and
  // leaves the address at once: the code is single use, and a reload could
  // only fail. The dialog is offered it until it closes, so opening "Pair an
  // agent" later starts from an empty code.
  const linked = useConsumedIntent('code')
  const [offeredCode, setOfferedCode] = useState<string | null>(null)
  useEffect(() => {
    if (!linked.value) return
    setOfferedCode(linked.value)
    setPairOpen(true)
  }, [linked.serial, linked.value])

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
    <Section
      actions={(
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          onClick={() => setPairOpen(true)}
          type="button"
        >
          <FontAwesomeIcon className="h-3 w-3" icon={faPlus} />
          Pair an agent
        </button>
      )}
      description={
        'Claude Code, Codex and other MCP clients, working in Nessie as you. A paired agent '
        + 'reaches exactly what you reach and never more, and it cannot publish a document on '
        + 'its own — that comes back to you as an approval. Everything you lend here you can '
        + 'take back here.'
      }
      title="Programs signed in as you"
    >
      <FormError>{actionError}</FormError>

      <PairedAgentsTable
        credentials={pageRows}
        emptyMessage="Nothing paired yet. No program is holding a credential for your account."
        isLoading={credentials.isPending}
        onOpen={(credentialId) => void navigate(`/settings/security/programs/${credentialId}`)}
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
        showOwner={false}
      />

      <PaginationFooter
        canNext={page < totalPages - 1}
        canPrevious={page > 0}
        hideWhenSinglePage
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

      <PairAgentDialog
        {...(offeredCode ? { initialCode: offeredCode } : {})}
        onClose={() => {
          setPairOpen(false)
          setOfferedCode(null)
        }}
        open={pairOpen}
      />
    </Section>
  )
}
