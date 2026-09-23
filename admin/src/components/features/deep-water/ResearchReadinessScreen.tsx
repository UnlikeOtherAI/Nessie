import { Link } from 'react-router-dom'
import type { DeepWaterResearchReadinessState } from '@nessie/schemas'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { READINESS_UNREAD_COPY, readinessCopy } from './research-presentation'

/**
 * Why research cannot start here yet, and the one way forward (nessie.md
 * §7.7 "the not-ready dialog screen"): a team owner is sent to the DeepWater
 * page, where they turn it on or update it for the team — only an owner may
 * (`viewerIsOwner`, the team-enablement route's own standing) — anyone else,
 * admins included, is told who can; a person whose sign-in is not linked signs
 * in again.
 * The composer button always opens this rather than hiding, so research is
 * never a feature a person cannot find.
 */

export const DEEP_WATER_APP_PATH = '/apps/deep-water'

export const ResearchReadinessScreen = ({
  onClose,
  state,
  viewerIsOwner,
}: {
  onClose: () => void
  state: Exclude<DeepWaterResearchReadinessState, 'ready'>
  viewerIsOwner: boolean
}) => {
  const { logout } = useAuthSession()
  const copy = readinessCopy(state, viewerIsOwner)
  const ownerAction = viewerIsOwner && (state === 'team_off' || state === 'contract_outdated')
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

/**
 * The products list could not be read, or its verdict broke the contract
 * (`useDeepWaterReadiness().isError`): said as that, with Try again — never as
 * DeepWater being off or unreachable, which the server has not said.
 */
export const ResearchReadinessUnread = ({ onRetry }: { onRetry: () => void }) => (
  <div className="flex flex-col items-start gap-2" data-testid="research-readiness-unread" role="alert">
    <p className="text-sm font-semibold text-[color:var(--tx)]">{READINESS_UNREAD_COPY.title}</p>
    <p className="text-sm text-[color:var(--tx2)]">{READINESS_UNREAD_COPY.message}</p>
    <button className="admin-button admin-button-secondary admin-button-compact" onClick={onRetry} type="button">
      Try again
    </button>
  </div>
)
