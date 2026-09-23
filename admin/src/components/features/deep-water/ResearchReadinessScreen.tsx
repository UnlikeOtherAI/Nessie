import { Link } from 'react-router-dom'
import type { DeepWaterResearchReadinessState } from '@nessie/schemas'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { readinessCopy } from './research-presentation'

/**
 * Why research cannot start here yet, and the one way forward (nessie.md
 * §7.7 "the not-ready dialog screen"): a team owner is sent to the DeepWater
 * page, where they turn it on or update it for the team — only an owner may
 * (the readiness verdict's `viewerCanChangeTeam`) — anyone else, admins
 * included, is told who can; a person whose sign-in is not linked signs in
 * again.
 * The composer button always opens this rather than hiding, so research is
 * never a feature a person cannot find.
 */

export const DEEP_WATER_APP_PATH = '/apps/deep-water'

export const ResearchReadinessScreen = ({
  onClose,
  state,
  viewerCanChangeTeam,
}: {
  onClose: () => void
  state: Exclude<DeepWaterResearchReadinessState, 'ready'>
  viewerCanChangeTeam: boolean
}) => {
  const { logout } = useAuthSession()
  const copy = readinessCopy(state, viewerCanChangeTeam)
  const ownerAction = viewerCanChangeTeam && (state === 'team_off' || state === 'contract_outdated')
    ? state === 'team_off' ? 'Turn on DeepWater' : 'Update DeepWater'
    : null

  return (
    <div className="flex flex-col gap-4" data-testid="research-readiness" data-state={state}>
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-[color:var(--tx)]">{copy.title}</h3>
        <p className="text-sm text-[color:var(--tx2)]">{copy.message}</p>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-[color:var(--sep)] pt-3">
        <button className="admin-button admin-button-secondary" onClick={onClose} type="button">
          Close
        </button>
        {ownerAction ? (
          <Link className="admin-button admin-button-primary" onClick={onClose} to={DEEP_WATER_APP_PATH}>
            {ownerAction}
          </Link>
        ) : null}
        {state === 'account_not_linked' ? (
          <button className="admin-button admin-button-primary" onClick={() => void logout()} type="button">
            Sign in again
          </button>
        ) : null}
      </div>
    </div>
  )
}
