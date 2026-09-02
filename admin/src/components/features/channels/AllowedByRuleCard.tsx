import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Pill } from '../../primitives/Pill'

/**
 * "This was allowed by a rule you set."
 *
 * The receipt for an action a standing grant let through without asking. A
 * rule that silences the prompt must not silence the fact: the person should
 * be able to see what happened, which of their rules allowed it, and where to
 * change their mind — without having to go looking.
 *
 * Server-authored from the chokepoint, and basis-stamped to the acting person,
 * so it never appears to anybody else in the room.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

export type AllowedByRule = {
  headline: string
  audience: string | null
  details: string | null
  /** The person's own boundary text, when they wrote one. */
  rule: string | null
}

export const readAllowedByRule = (
  metadata: Record<string, unknown> | undefined,
): AllowedByRule | null => {
  const card = metadata?.card
  if (!isRecord(card) || card.kind !== 'allowed_by_rule') return null
  if (typeof card.headline !== 'string') return null
  return {
    headline: card.headline,
    audience: typeof card.audience === 'string' ? card.audience : null,
    details: typeof card.details === 'string' ? card.details : null,
    rule: typeof card.rule === 'string' ? card.rule : null,
  }
}

export const AllowedByRuleCard = ({
  metadata,
}: {
  metadata: Record<string, unknown> | undefined
}) => {
  const card = readAllowedByRule(metadata)
  const [showDetails, setShowDetails] = useState(false)

  if (!card) return null

  return (
    <div
      className="mt-2 max-w-2xl rounded-lg border border-[color:var(--sep)] bg-[color:var(--panel)] p-3"
      data-testid="allowed-by-rule-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-sm font-semibold text-[color:var(--tx)]">
          {card.headline}
        </span>
        <Pill radius="chip" size="sm" tone="success" uppercase={false}>
          Always allowed
        </Pill>
      </div>

      <p className="mt-1 text-xs leading-5 text-[color:var(--tx2)]">
        {card.rule ? (
          <>
            Allowed by what you told me:{' '}
            <span className="text-[color:var(--tx)]">“{card.rule}”</span>
          </>
        ) : (
          <>You turned off confirmation for this account.</>
        )}{' '}
        <Link
          className="font-semibold text-[color:var(--accent)]"
          to="/settings/connections"
        >
          Change this
        </Link>
      </p>

      {card.audience ? (
        <p className="mt-1 text-xs text-[color:var(--tx3)]">{card.audience}</p>
      ) : null}

      {/* Details are collapsed: the headline is what a person reads, and the
          exact arguments are what they check when something looks wrong. */}
      {card.details ? (
        <div className="mt-2">
          <button
            className="text-[11px] font-semibold text-[color:var(--tx3)]"
            onClick={() => setShowDetails((value) => !value)}
            type="button"
          >
            {showDetails ? '⌄ Hide the details' : '› Show the details'}
          </button>
          {showDetails ? (
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-2 text-[11px] leading-4 text-[color:var(--tx2)]">
              {card.details}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
