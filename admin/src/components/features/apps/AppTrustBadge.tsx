import {
  faBan,
  faCircleCheck,
  faCircleQuestion,
  faShieldHalved,
  faUsers,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { AppTrustLevel } from '@nessie/schemas'
import { appTrustBadge, type AppTrustIconId } from './app-trust'

const ICONS: Record<AppTrustIconId, IconDefinition> = {
  shield: faShieldHalved,
  verified: faCircleCheck,
  community: faUsers,
  unknown: faCircleQuestion,
  blocked: faBan,
}

type AppTrustBadgeProps = {
  trustLevel: AppTrustLevel
}

// Who published this, in one chip. Identical on the card and in the detail
// hero, so clicking through never changes the story.
export const AppTrustBadge = ({ trustLevel }: AppTrustBadgeProps) => {
  const badge = appTrustBadge(trustLevel)

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5',
        'text-[11px] font-medium',
        badge.toneClass,
      ].join(' ')}
      data-testid={`app-trust-${trustLevel}`}
      title={badge.description}
    >
      <FontAwesomeIcon className="h-2.5 w-2.5" icon={ICONS[badge.iconId]} />
      {badge.label}
    </span>
  )
}
