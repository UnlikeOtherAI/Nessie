import { Link } from 'react-router-dom'

import { useCurrentOrganization } from '../../../../facades/organization/hooks'

/**
 * The doorway from "this agent's model is gone" to the page that decides it.
 *
 * The designer is where somebody is standing when a model turns out to be
 * unavailable, so this is where the organisation's Models page has to be
 * reachable from (AGENTS.md → Rule zero, check 1). The picker offers only
 * models the organisation allows, which means a selection that is missing from
 * it has exactly two causes — the model service retired the pair, or an
 * organisation owner switched it off — and the two are indistinguishable from
 * here by construction: a filtered list cannot say why something is not in it.
 * So the notice names both, and the link is shown only to somebody who can act
 * on the second, matching the nav item's own `ownerOnly` gate.
 */
export const ModelUnavailableNotice = ({ model }: { model: string }) => {
  const organization = useCurrentOrganization()
  const canManageOrganization = organization.data?.administration.status === 'allowed'

  return (
    <p className="text-xs text-[color:var(--tx3)]">
      {model
        ? `Current model (${model}) is not available — it has either been retired or switched `
          + 'off for this organisation. Select a replacement.'
        : 'This agent’s stored model could not be matched — select a replacement.'}
      {canManageOrganization ? (
        <>
          {' '}
          <Link className="underline" to="/settings/organization/models">
            Organization models →
          </Link>
        </>
      ) : null}
    </p>
  )
}
