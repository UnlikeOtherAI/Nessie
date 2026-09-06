import { useState } from 'react'
import { Row, RowList } from '../../../components/shared/RowList'
import { sectionTitleClass } from '../settings-presentation'
import {
  useGrantSendAuthorization,
  useRevokeSendGrant,
  useSendGrants,
  type SendGrant,
} from '../../../facades/gmail/hooks'
import { SendBoundaryEditor } from './SendBoundaryEditor'

/**
 * Standing permission for agents to act on your behalf.
 *
 * The home for a consent given in two other places — after the Google grant,
 * and on an approval card's "don't ask again" — so it is where a person comes
 * to see what they agreed to and take it back. Showing the expiry matters: a
 * grant with no visible end is one nobody remembers giving.
 *
 * Two positions beyond "ask me every time": send whenever I ask, and decide
 * within a boundary I wrote. The boundary is the person's own words, judged per
 * action; this screen is where they edit it after seeing how it went.
 */

const formatExpiry = (expiresAt: string | null): string =>
  expiresAt === null
    ? 'Until you revoke it'
    : `Until ${new Date(expiresAt).toLocaleString()}`

/** The running shape of a judged grant: what it did, not how confident it was. */
const decisionShape = (grant: SendGrant): string | null => {
  if (grant.mode !== 'judged') return null
  if (grant.decidedCount === 0 && grant.askedCount === 0) {
    return 'Nothing yet'
  }
  return `${grant.decidedCount} sent · ${grant.askedCount} asked you`
}

const GrantRow = ({
  grant,
  onRevoke,
  revoking,
}: {
  grant: SendGrant
  onRevoke: () => void
  revoking: boolean
}) => {
  const update = useGrantSendAuthorization()
  const [editing, setEditing] = useState(false)
  const [boundary, setBoundary] = useState(grant.boundary ?? '')

  const save = () => {
    update.mutate(
      {
        connectionId: grant.connectionId,
        agentId: grant.agentId,
        duration: '30d',
        mode: 'judged',
        boundary,
      },
      { onSuccess: () => setEditing(false) },
    )
  }

  return (
    <Row
      title={
        <span className="text-xs font-semibold text-[color:var(--tx)]">
          {grant.agentName}
          {grant.accountEmail ? (
            <span className="ml-1.5 font-normal text-[color:var(--tx3)]">
              — {grant.accountEmail}
            </span>
          ) : null}
        </span>
      }
      trailing={
        <button
          className="admin-button admin-button-secondary admin-button-danger"
          disabled={revoking}
          onClick={onRevoke}
          type="button"
        >
          Revoke
        </button>
      }
    >
      <p className="mt-1 text-[11px] text-[color:var(--tx3)]">
        {grant.mode === 'judged'
          ? 'Decides within your note, and asks when unsure'
          : 'Sends whenever you ask'}
        {' · '}
        {formatExpiry(grant.expiresAt)}
        {decisionShape(grant) ? ` · ${decisionShape(grant)}` : ''}
      </p>
      {grant.mode === 'judged' && !editing ? (
        <p className="mt-1 text-[11px] leading-4 text-[color:var(--tx2)]">
          “{grant.boundary}”{' '}
          <button
            className="font-semibold text-[color:var(--accent)]"
            onClick={() => setEditing(true)}
            type="button"
          >
            Edit
          </button>
        </p>
      ) : null}
      {editing ? (
        <>
          <SendBoundaryEditor
            disabled={update.isPending}
            onChange={setBoundary}
            value={boundary}
          />
          <div className="mt-2 flex gap-2">
            <button
              className="admin-button admin-button-primary"
              disabled={update.isPending || boundary.trim().length === 0}
              onClick={save}
              type="button"
            >
              Save
            </button>
            <button
              className="admin-button admin-button-secondary"
              disabled={update.isPending}
              onClick={() => setEditing(false)}
              type="button"
            >
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </Row>
  )
}

export const SendAuthorizationSection = () => {
  const grants = useSendGrants()
  const revoke = useRevokeSendGrant()
  const rows = grants.data?.grants ?? []

  // Nothing granted is the normal state; an empty section would be noise.
  if (rows.length === 0) return null

  return (
    <section className="admin-card p-4" data-testid="send-authorizations">
      <h2 className={sectionTitleClass}>Acting on your behalf</h2>
      <p className="mt-1 text-xs leading-5 text-[color:var(--tx3)]">
        These agents can act as you when you ask them to, without approving each
        one. They can never act from an automation or a schedule, and never on
        something other than what you saw.
      </p>
      <div className="mt-2">
        <RowList label="Standing send permissions">
          {rows.map((grant) => (
            <GrantRow
              grant={grant}
              key={grant.id}
              onRevoke={() => revoke.mutate(grant.id)}
              revoking={revoke.isPending}
            />
          ))}
        </RowList>
      </div>
    </section>
  )
}
