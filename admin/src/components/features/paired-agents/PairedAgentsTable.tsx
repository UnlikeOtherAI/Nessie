import { faChevronRight } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AgentAccessScope } from '../../../facades/agent-access/hooks'
import { Pill } from '../../primitives/Pill'
import { Skeleton } from '../../primitives/Skeleton'
import { ExpandableTable } from '../../shared/ExpandableTable'
import {
  credentialLifecycle,
  credentialTone,
  describeScopes,
  formatCredentialDate,
  formatLastUsed,
} from './paired-agent-presentation'

/**
 * The fields both paired-agent lists share. The organisation view adds the
 * person whose account a credential borrows; the personal one does not, because
 * there the answer is always "you".
 */
export type PairedAgentRow = {
  createdAt: string
  expiresAt: string
  id: string
  label: string
  lastUsedAt: string | null
  revokedAt: string | null
  scopes: AgentAccessScope[]
  user?: { displayName: string; id: string }
}

type PairedAgentsTableProps = {
  credentials: PairedAgentRow[]
  emptyMessage: string
  isLoading: boolean
  onOpen: (credentialId: string) => void
  onRevoke: (credentialId: string) => void
  revokePending: boolean
  /** The organisation view names whose account each credential works as. */
  showOwner: boolean
}

const SKELETON_ROWS = 4

const TableFrame = ({ children }: { children: React.ReactNode }) => (
  <ExpandableTable
    className="overflow-hidden rounded-xl border border-[color:var(--sep)]"
    expandable={false}
    label="Programs table"
  >
    <table className="admin-table w-full border-collapse">{children}</table>
  </ExpandableTable>
)

const headerClass = [
  'px-3 py-2 text-left text-[11px] font-semibold uppercase',
  'tracking-[0.12em] text-[color:var(--tx3)]',
].join(' ')

export const PairedAgentsTable = ({
  credentials,
  emptyMessage,
  isLoading,
  onOpen,
  onRevoke,
  revokePending,
  showOwner,
}: PairedAgentsTableProps) => {
  const columnCount = showOwner ? 6 : 5

  const header = (
    <thead>
      <tr className="border-b border-[color:var(--sep)]">
        <th className={`${headerClass} pl-4`} scope="col">Program</th>
        <th className={headerClass} scope="col">Status</th>
        {showOwner ? (
          <th className={`${headerClass} hidden md:table-cell`} scope="col">Works as</th>
        ) : null}
        <th className={`${headerClass} hidden lg:table-cell`} scope="col">Expires</th>
        <th className={headerClass} scope="col"><span className="sr-only">Revoke</span></th>
        <th className={headerClass} scope="col"><span className="sr-only">Open</span></th>
      </tr>
    </thead>
  )

  if (isLoading) {
    return (
      <TableFrame>
        {header}
        <tbody>
          <tr>
            <td className="px-4 py-4" colSpan={columnCount}>
              <Skeleton count={SKELETON_ROWS} variant="list" />
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  if (credentials.length === 0) {
    return (
      <TableFrame>
        {header}
        <tbody>
          <tr>
            <td
              className="px-4 py-12 text-center text-sm text-[color:var(--tx3)]"
              colSpan={columnCount}
            >
              {emptyMessage}
            </td>
          </tr>
        </tbody>
      </TableFrame>
    )
  }

  return (
    <TableFrame>
      {header}
      <tbody>
        {credentials.map((credential) => {
          const lifecycle = credentialLifecycle(credential)
          return (
            <tr
              className="cursor-pointer"
              key={credential.id}
              onClick={() => onOpen(credential.id)}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onOpen(credential.id)
                }
              }}
            >
              <td className="min-w-0 py-2.5 pl-4 pr-3 align-middle">
                <div className="truncate text-sm font-medium text-[color:var(--tx)]">
                  {credential.label}
                </div>
                <div className="truncate text-xs text-[color:var(--tx3)]">
                  {describeScopes(credential.scopes)} · {formatLastUsed(credential.lastUsedAt)}
                </div>
              </td>
              <td className="w-32 px-3 py-2.5 align-middle">
                <Pill height="control" tone={credentialTone(lifecycle)} uppercase={false}>
                  {lifecycle}
                </Pill>
              </td>
              {showOwner ? (
                <td className="hidden w-44 px-3 py-2.5 align-middle text-xs text-[color:var(--tx2)] md:table-cell">
                  {credential.user?.displayName ?? '—'}
                </td>
              ) : null}
              <td className="hidden w-40 px-3 py-2.5 align-middle text-xs text-[color:var(--tx3)] lg:table-cell">
                {credential.revokedAt
                  ? `revoked ${formatCredentialDate(credential.revokedAt)}`
                  : formatCredentialDate(credential.expiresAt)}
              </td>
              <td className="w-24 px-3 py-2.5 text-right align-middle">
                {lifecycle === 'active' ? (
                  <button
                    className="admin-button admin-button-secondary admin-button-compact"
                    disabled={revokePending}
                    onClick={(event) => {
                      // The row opens the credential; revoking must not do both.
                      event.stopPropagation()
                      onRevoke(credential.id)
                    }}
                    type="button"
                  >
                    Revoke
                  </button>
                ) : null}
              </td>
              <td className="w-9 py-2.5 pl-0 pr-4 text-right align-middle">
                <FontAwesomeIcon className="h-3 w-3 text-[color:var(--tx3)]" icon={faChevronRight} />
              </td>
            </tr>
          )
        })}
      </tbody>
    </TableFrame>
  )
}
