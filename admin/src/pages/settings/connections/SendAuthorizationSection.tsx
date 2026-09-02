import { Row, RowList } from '../../../components/shared/RowList'
import { sectionTitleClass } from '../settings-shared'
import { useRevokeSendGrant, useSendGrants } from '../../../facades/gmail/hooks'

/**
 * Standing permission for agents to send email on your behalf.
 *
 * This is the home for a consent given in two other places — right after the
 * Google grant, and on the draft card's "don't ask again" — so it is where a
 * person comes to see what they agreed to and take it back. Showing the expiry
 * matters: a grant with no visible end is one nobody remembers giving.
 */

const formatExpiry = (expiresAt: string | null): string =>
  expiresAt === null
    ? 'Until you revoke it'
    : `Until ${new Date(expiresAt).toLocaleString()}`

export const SendAuthorizationSection = () => {
  const grants = useSendGrants()
  const revoke = useRevokeSendGrant()
  const rows = grants.data?.grants ?? []

  // Nothing granted is the normal state; an empty section would be noise.
  if (rows.length === 0) return null

  return (
    <section className="admin-card p-4" data-testid="send-authorizations">
      <h2 className={sectionTitleClass}>Send on your behalf</h2>
      <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
        These agents can send email as you when you ask them to, without
        approving each message. They can never send from an automation or a
        schedule, and never to something other than what you saw.
      </p>
      <div className="mt-2">
        <RowList label="Standing send permissions">
          {rows.map((grant) => (
            <Row
              key={grant.id}
              title={
                <span className="text-xs font-semibold text-[color:var(--tx)]">
                  {grant.agentName}
                </span>
              }
              trailing={
                <button
                  className="admin-button admin-button-secondary admin-button-danger"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(grant.id)}
                  type="button"
                >
                  Revoke
                </button>
              }
            >
              <p className="mt-1 text-[11px] text-[color:var(--tx3)]">
                {formatExpiry(grant.expiresAt)}
              </p>
            </Row>
          ))}
        </RowList>
      </div>
    </section>
  )
}
