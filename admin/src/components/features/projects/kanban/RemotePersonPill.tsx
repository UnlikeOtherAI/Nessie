import { faUserSlash } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { PROVIDER_LABEL, type BoardSourceProvider } from '../../../../facades/board-sources/hooks'
import { Pill } from '../../../primitives/Pill'

type RemotePersonPillProps = {
  className?: string
  displayName: string
  provider: BoardSourceProvider
}

/**
 * The person a provider says is on a mirrored item, when Nessie does not know
 * who that is.
 *
 * The name is the provider's own data and is shown as such — a card that read
 * "Unassigned" would be wrong, and one that drew this name the way it draws a
 * colleague's would claim an account that does not exist. So it is the
 * *upstream* chip: outlined rather than filled, like the item's own key pill,
 * with the crossed-out person that says nobody here answers to this name, and
 * a title that names the remedy.
 */
export const RemotePersonPill = ({
  className,
  displayName,
  provider,
}: RemotePersonPillProps) => (
  <Pill
    className={`gap-1.5 truncate ${className ?? ''}`}
    size="sm"
    title={`${displayName} is a ${PROVIDER_LABEL[provider]} user with no Nessie account. Link them in Settings → Sources → People.`}
    tone="outline"
    uppercase={false}
  >
    <FontAwesomeIcon className="shrink-0 text-[9px]" icon={faUserSlash} />
    <span className="truncate">{displayName}</span>
  </Pill>
)
