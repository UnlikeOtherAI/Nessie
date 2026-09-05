import { useEffect, useId, useState } from 'react'
import {
  computeSecretPrecedence,
  type SecretPrecedenceContext,
  type SecretScopeType,
  type SecretWithPrecedence,
} from '@nessie/schemas'

import { Pill, type PillTone } from '../../primitives/Pill'
import type { SecretRecord } from '../../../facades/secrets/hooks'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../shared/DataTable'
import { EmptyState } from '../../shared/EmptyState'

/** Which of the three Secrets pages this table is rendering. */
export type SecretPageScope = 'personal' | 'team' | 'organization'

export type SecretsTab = 'active' | 'revoked'

type SecretRow = SecretWithPrecedence<SecretRecord>

type SecretMetadataTableProps = {
  isLoading: boolean
  onRevoke: (reference: string) => void
  /** The page's own level, which decides whether a Scope column earns its place. */
  pageScope: SecretPageScope
  precedenceContext: SecretPrecedenceContext
  revokingReference: string | null
  secrets: SecretRecord[]
  tab: SecretsTab
}

/** One spelling of each scope, shared with the creation form's picker. */
export const SECRET_SCOPE_LABEL: Record<SecretScopeType, string> = {
  personal: 'Personal',
  project: 'Project',
  team: 'Team',
  organization: 'Organisation',
}

const statusTone: Record<SecretRecord['status'], PillTone> = {
  active: 'success',
  expired: 'warning',
  revoked: 'danger',
}

const statusLabel: Record<SecretRecord['status'], string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
}

const emptyCopy: Record<SecretPageScope, Record<SecretsTab, string>> = {
  organization: {
    active: 'No organisation secrets yet. Use “New secret” to add one everybody inherits.',
    revoked: 'No organisation secret has been revoked.',
  },
  personal: {
    active: 'No secrets reach you yet. Use “New secret” to save one of your own.',
    revoked: 'Nothing here has been revoked.',
  },
  team: {
    active: 'No secrets reach this team yet. Use “New secret” to add one.',
    revoked: 'No secret in this team has been revoked.',
  },
}

/**
 * The rows one page shows. Each level sees itself and everything above it,
 * because that is the whole point of the cascade: the organisation page is the
 * base and shows only its own, a team also carries what the organisation set,
 * and a person carries all three. A team a viewer does not belong to never
 * appears — `computeSecretPrecedence` would not resolve it either.
 */
export const belongsToSecretsPage = (
  secret: Pick<SecretRecord, 'scopeId' | 'scopeType'>,
  pageScope: SecretPageScope,
  context: SecretPrecedenceContext,
): boolean => {
  if (secret.scopeType === 'organization') return true
  if (pageScope === 'organization') return false
  if (secret.scopeType === 'team') return secret.scopeId === context.teamId
  if (pageScope === 'team') return false
  if (secret.scopeType === 'project') return secret.scopeId === context.projectId
  return secret.scopeId === context.userId
}

type CopySecretMetadataButtonProps = {
  label: string
  value: string
}

const CopySecretMetadataButton = ({ label, value }: CopySecretMetadataButtonProps) => {
  const feedbackId = useId()
  const [feedback, setFeedback] = useState<'copied' | 'error' | null>(null)

  useEffect(() => {
    if (!feedback) return undefined
    const timer = window.setTimeout(() => setFeedback(null), 1800)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard is unavailable')
      await navigator.clipboard.writeText(value)
      setFeedback('copied')
    } catch {
      setFeedback('error')
    }
  }

  const buttonLabel = feedback === 'copied'
    ? `${label} copied`
    : feedback === 'error'
      ? `Could not copy ${label.toLowerCase()}`
      : `Copy ${label.toLowerCase()}`
  // The visible label is just "Copy": the column header beside it already says
  // *what* is being copied, and spelling it out twice per row pushed the
  // Precedence and Actions columns off the side of a 1440px viewport. The full
  // sentence stays in the accessible name and the tooltip.
  const visibleLabel = feedback === 'copied'
    ? 'Copied'
    : feedback === 'error'
      ? 'Try again'
      : 'Copy'
  const message = feedback === 'copied'
    ? `${label} copied to clipboard.`
    : feedback === 'error'
      ? `Could not copy ${label.toLowerCase()}.`
      : ''

  return (
    <>
      <button
        aria-describedby={feedback ? feedbackId : undefined}
        aria-label={buttonLabel}
        className="admin-button admin-button-secondary admin-button-compact shrink-0"
        onClick={() => void copy()}
        title={buttonLabel}
        type="button"
      >
        {visibleLabel}
      </button>
      <span aria-live="polite" className="sr-only" id={feedbackId}>{message}</span>
    </>
  )
}

const MetadataCell = ({ label, value }: { label: string; value: string }) => (
  <div className="flex min-w-0 items-center gap-2">
    <code className="min-w-0 truncate font-mono text-sm text-[color:var(--tx)]" title={value}>{value}</code>
    <CopySecretMetadataButton label={label} value={value} />
  </div>
)

const PrecedenceCell = ({ secret }: { secret: SecretRow }) => {
  if (secret.lockedBy) {
    return (
      <span className="text-sm text-[color:var(--tx3)]">
        Locked by {SECRET_SCOPE_LABEL[secret.lockedBy.scopeType].toLowerCase()}
      </span>
    )
  }
  if (secret.isEffective) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Pill radius="chip" size="sm" tone="success" uppercase={false}>Effective</Pill>
        {secret.locked ? (
          <Pill radius="chip" size="sm" tone="muted" uppercase={false}>Locked</Pill>
        ) : null}
      </span>
    )
  }
  if (secret.overriddenBy) {
    return (
      <span className="text-sm text-[color:var(--tx3)]">
        Overridden by {SECRET_SCOPE_LABEL[secret.overriddenBy.scopeType].toLowerCase()}
      </span>
    )
  }
  return <span className="text-sm text-[color:var(--tx3)]">—</span>
}

/**
 * Metadata only: a secret value is not part of `SecretRecord`, so this table can
 * safely expose the key and opaque reference people need for later binding.
 *
 * It owns its own frame (`DataTable`) and is never wrapped in a card — the
 * design system's no-nesting rule, which this surface used to break by putting
 * the table inside an `admin-card` with its own header.
 *
 * A row pinned by a lock above is shown and dimmed rather than hidden, the same
 * bargain `ScopedSettingGate` strikes for a single control: hiding it would
 * leave somebody wondering where their credential went. Its Revoke button stays
 * live, because a secret you can no longer use is still one you may want gone.
 */
export const SecretMetadataTable = ({
  isLoading,
  onRevoke,
  pageScope,
  precedenceContext,
  revokingReference,
  secrets,
  tab,
}: SecretMetadataTableProps) => {
  const [pendingRevoke, setPendingRevoke] = useState<SecretRow | null>(null)
  // Precedence is resolved over every secret the viewer can see, then filtered:
  // resolving the filtered set would let a page's own narrowing invent a winner
  // that does not apply in reality.
  const rows = computeSecretPrecedence(secrets, precedenceContext)
    .filter((secret) => belongsToSecretsPage(secret, pageScope, precedenceContext))
    .filter((secret) => (tab === 'active' ? secret.status === 'active' : secret.status !== 'active'))

  const active = tab === 'active'
  const columns: (DataTableColumn<SecretRow> | null)[] = [
    {
      header: 'Secret key',
      key: 'name',
      render: (secret) => <MetadataCell label="Secret key" value={secret.name} />,
    },
    {
      header: 'Reference',
      key: 'reference',
      render: (secret) => <MetadataCell label="Secret reference" value={secret.reference} />,
    },
    // The organisation page is a single level, so every row would read
    // "Organisation" — the page title already says it.
    pageScope === 'organization' ? null : {
      header: 'Scope',
      key: 'scope',
      render: (secret) => SECRET_SCOPE_LABEL[secret.scopeType],
      secondary: true,
    },
    active ? {
      header: 'Precedence',
      key: 'precedence',
      render: (secret) => <PrecedenceCell secret={secret} />,
      secondary: true,
    } : {
      // Revoked and expired are different facts and the tab holds both; on the
      // Active tab the tab itself is the status and a column would only repeat it.
      header: 'Status',
      key: 'status',
      render: (secret) => (
        <Pill radius="chip" size="sm" tone={statusTone[secret.status]} uppercase={false}>
          {statusLabel[secret.status]}
        </Pill>
      ),
    },
    active ? {
      align: 'right',
      header: 'Actions',
      key: 'actions',
      render: (secret) => (
        <button
          className="admin-button admin-button-secondary admin-button-compact"
          disabled={revokingReference === secret.reference}
          onClick={() => setPendingRevoke(secret)}
          type="button"
        >
          {revokingReference === secret.reference ? 'Revoking…' : 'Revoke'}
        </button>
      ),
      width: '7rem',
    } : null,
  ]

  return (
    <>
      <DataTable
        columns={columns.filter((column): column is DataTableColumn<SecretRow> => column !== null)}
        empty={<EmptyState>{emptyCopy[pageScope][tab]}</EmptyState>}
        expandable={false}
        label="Secrets table"
        loading={isLoading}
        minWidth="46rem"
        rowClassName={(secret) => (secret.lockedBy ? 'opacity-60' : undefined)}
        rowKey={(secret) => secret.reference}
        rows={rows}
        skeletonRows={4}
      />

      <ConfirmDialog
        body={pendingRevoke ? `"${pendingRevoke.name}" will stop working anywhere it is bound.` : undefined}
        confirmLabel="Revoke"
        destructive
        onCancel={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) onRevoke(pendingRevoke.reference)
          setPendingRevoke(null)
        }}
        open={pendingRevoke !== null}
        title="Revoke this secret?"
      />
    </>
  )
}
