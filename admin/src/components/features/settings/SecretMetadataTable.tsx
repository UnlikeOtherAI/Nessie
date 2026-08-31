import { useEffect, useId, useState } from 'react'

import { Pill, type PillTone } from '../../primitives/Pill'
import type { SecretRecord, SecretScopeType } from '../../../facades/secrets/hooks'

type SecretMetadataTableProps = {
  isLoading: boolean
  onRevoke: (reference: string) => void
  revokingReference: string | null
  secrets: SecretRecord[]
}

const scopeLabel: Record<SecretScopeType, string> = {
  personal: 'Personal',
  project: 'Project',
  team: 'Team',
  workspace: 'Workspace',
}

const statusTone: Record<SecretRecord['status'], PillTone> = {
  active: 'success',
  expired: 'warning',
  revoked: 'danger',
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
}: SecretMetadataTableProps) => (
  <div
    aria-label="Secrets table. Scroll horizontally to view all columns."
    className="overflow-x-auto"
    tabIndex={0}
  >
    <table className="admin-table min-w-[46rem] w-full border-collapse">
      <caption className="sr-only">Available secret metadata</caption>
      <thead>
        <tr className="border-b border-[color:var(--sep)]">
          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
            Secret key
          </th>
          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
            Reference
          </th>
          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
            Scope
          </th>
          <th className="px-4 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
            Status
          </th>
          <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--tx3)]" scope="col">
            Actions
          </th>
        </tr>
      </thead>
      <tbody>
        {isLoading ? (
          <tr>
            <td className="px-4 py-10 text-center text-sm text-[color:var(--tx3)]" colSpan={5} role="status">
              Loading secrets…
            </td>
          </tr>
        ) : secrets.length === 0 ? (
          <tr>
            <td className="px-4 py-10 text-center text-sm text-[color:var(--tx3)]" colSpan={5}>
              No secrets saved yet. Use “Save a secret” to add one.
            </td>
          </tr>
        ) : secrets.map((secret) => (
          <tr className="border-b border-[color:var(--sep)] last:border-b-0" key={secret.reference}>
            <td className="max-w-64 px-4 py-3 align-middle">
              <MetadataCell label="Secret key" value={secret.name} />
            </td>
            <td className="max-w-80 px-4 py-3 align-middle">
              <MetadataCell label="Secret reference" value={secret.reference} />
            </td>
            <td className="whitespace-nowrap px-4 py-3 text-sm text-[color:var(--tx2)]">
              {scopeLabel[secret.scopeType]}
            </td>
            <td className="whitespace-nowrap px-4 py-3">
              <Pill radius="chip" size="sm" tone={statusTone[secret.status]}>{secret.status}</Pill>
            </td>
            <td className="px-4 py-3 text-right">
              {secret.status === 'active' ? (
                <button
                  className="admin-button admin-button-secondary admin-button-compact"
                  disabled={revokingReference === secret.reference}
                  onClick={() => onRevoke(secret.reference)}
                  type="button"
                >
                  {revokingReference === secret.reference ? 'Revoking…' : 'Revoke'}
                </button>
              ) : <span className="text-sm text-[color:var(--tx3)]">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)
