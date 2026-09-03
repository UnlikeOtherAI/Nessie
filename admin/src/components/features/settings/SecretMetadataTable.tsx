import { useEffect, useId, useState } from 'react'

import { Pill, type PillTone } from '../../primitives/Pill'
import type { SecretRecord, SecretScopeType } from '../../../facades/secrets/hooks'
import {
  computeSecretPrecedence,
  type SecretPrecedenceContext,
  type SecretWithPrecedence,
} from '../../../lib/secret-precedence'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { DataTable, type DataTableColumn } from '../../shared/DataTable'
import { EmptyState } from '../../shared/EmptyState'

type SecretMetadataTableProps = {
  isLoading: boolean
  onRevoke: (reference: string) => void
  revokingReference: string | null
  secrets: SecretRecord[]
  precedenceContext: SecretPrecedenceContext
}

const scopeLabel: Record<SecretScopeType, string> = {
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
  const visibleLabel = feedback === 'copied'
    ? 'Copied'
    : feedback === 'error'
      ? 'Try again'
      : `Copy ${label.toLowerCase()}`
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

/**
 * Metadata only: a secret value is not part of SecretRecord, so this table can
 * safely expose the key and opaque reference people need for later binding.
 */
export const SecretMetadataTable = ({
  isLoading,
  onRevoke,
  revokingReference,
  secrets,
  precedenceContext,
}: SecretMetadataTableProps) => {
  const [pendingRevoke, setPendingRevoke] = useState<SecretWithPrecedence | null>(null)
  const rows = computeSecretPrecedence(secrets, precedenceContext)

  const columns: DataTableColumn<SecretWithPrecedence>[] = [
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
    {
      header: 'Scope',
      key: 'scope',
      render: (secret) => scopeLabel[secret.scopeType],
      secondary: true,
    },
    {
      header: 'Precedence',
      key: 'precedence',
      render: (secret) => (
        secret.isEffective ? (
          <Pill radius="chip" size="sm" tone="success" uppercase={false}>Effective</Pill>
        ) : secret.overriddenBy ? (
          <span className="text-sm text-[color:var(--tx3)]">
            Overridden by {scopeLabel[secret.overriddenBy.scopeType]}
          </span>
        ) : (
          <span className="text-sm text-[color:var(--tx3)]">—</span>
        )
      ),
      secondary: true,
    },
    {
      header: 'Status',
      key: 'status',
      render: (secret) => (
        <Pill radius="chip" size="sm" tone={statusTone[secret.status]} uppercase={false}>
          {statusLabel[secret.status]}
        </Pill>
      ),
    },
    {
      align: 'right',
      header: 'Actions',
      key: 'actions',
      render: (secret) => (
        secret.status === 'active' ? (
          <button
            className="admin-button admin-button-secondary admin-button-compact"
            disabled={revokingReference === secret.reference}
            onClick={() => setPendingRevoke(secret)}
            type="button"
          >
            {revokingReference === secret.reference ? 'Revoking…' : 'Revoke'}
          </button>
        ) : <span className="text-sm text-[color:var(--tx3)]">—</span>
      ),
      width: '7rem',
    },
  ]

  return (
    <>
      <DataTable
        columns={columns}
        empty={<EmptyState>No secrets saved yet. Use “Save a secret” to add one.</EmptyState>}
        label="Secrets table"
        loading={isLoading}
        minWidth="46rem"
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
