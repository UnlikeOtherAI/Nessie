import { Card } from '../../shared/Card'
import { KeyValueList } from '../../shared/KeyValueList'
import { SectionLabel } from '../../primitives/SectionLabel'
import type { PairedAgentRow } from './PairedAgentsTable'
import {
  SCOPE_COPY,
  SCOPE_ORDER,
  credentialLifecycle,
  formatCredentialDate,
  formatLastUsed,
} from './paired-agent-presentation'

type PairedAgentDetailProps = {
  credential: PairedAgentRow
}

/**
 * What one paired agent can actually reach.
 *
 * The row can only afford a phrase — "Read and change boards, draft documents"
 * — and a phrase is not enough to revoke on. Here every permission is named
 * with the sentence that says what it means, granted or not, so the question a
 * person came with ("can this thing edit my documents?") is answered without
 * them having to decode a summary.
 */
export const PairedAgentDetail = ({ credential }: PairedAgentDetailProps) => {
  const lifecycle = credentialLifecycle(credential)

  return (
    <div className="grid max-w-3xl gap-4">
      <Card as="section">
        <SectionLabel>What it can do</SectionLabel>
        <div className="mt-3 grid gap-3">
          {SCOPE_ORDER.map((scope) => {
            const held = credential.scopes.includes(scope)
            return (
              <div className="flex items-start gap-3" key={scope}>
                <span
                  aria-hidden
                  className={[
                    'mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px]',
                    held
                      ? 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
                      : 'bg-[color:var(--overlay-weak)] text-[color:var(--tx3)]',
                  ].join(' ')}
                >
                  {held ? '✓' : '—'}
                </span>
                <div className="min-w-0">
                  <div
                    className={[
                      'text-sm font-medium',
                      held ? 'text-[color:var(--tx)]' : 'text-[color:var(--tx3)]',
                    ].join(' ')}
                  >
                    {SCOPE_COPY[scope].label}
                    {held ? '' : ' — not granted'}
                  </div>
                  <p className="mt-0.5 text-xs text-[color:var(--tx3)]">
                    {SCOPE_COPY[scope].detail}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      <Card as="section">
        <SectionLabel>Credential</SectionLabel>
        <div className="mt-3">
          <KeyValueList
            items={[
              ...(credential.user
                ? [{ label: 'Works as', value: credential.user.displayName }]
                : [{ label: 'Works as', value: 'You' }]),
              { label: 'Paired', value: formatCredentialDate(credential.createdAt) },
              {
                label: lifecycle === 'revoked' ? 'Revoked' : 'Expires',
                value: formatCredentialDate(credential.revokedAt ?? credential.expiresAt),
              },
              { label: 'Last used', value: formatLastUsed(credential.lastUsedAt) },
            ]}
          />
        </div>
      </Card>
    </div>
  )
}
