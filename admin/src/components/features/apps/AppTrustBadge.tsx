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
import { AppIconBadge } from './AppIconBadge'

const ICONS: Record<AppTrustIconId, IconDefinition> = {
  shield: faShieldHalved,
  verified: faCircleCheck,
  community: faUsers,
  unknown: faCircleQuestion,
  blocked: faBan,
}

type AppTrustBadgeProps = {
  /** Cards use the compact version; the detail hero keeps the named chip. */
  iconOnly?: boolean
  trustLevel: AppTrustLevel
}

// Who published this. The detail hero keeps the named chip; a card uses the
// same model as an icon-only badge so its compactness never erases the meaning.
export const AppTrustBadge = ({ iconOnly = false, trustLevel }: AppTrustBadgeProps) => {
  const badge = appTrustBadge(trustLevel)

  if (iconOnly) {
    return (
      <AppIconBadge
        description={badge.description}
        icon={ICONS[badge.iconId]}
        label={badge.label}
        testId={`app-trust-${trustLevel}`}
        toneClass={badge.toneClass}
      />
    )
  }

  return (
    <span
      className={[
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5',
        'text-[11px] font-medium',
        badge.toneClass,
      ].join(' ')}
      data-testid={`app-trust-${trustLevel}`}
    >
      <FontAwesomeIcon className="h-2.5 w-2.5" icon={ICONS[badge.iconId]} />
      {badge.label}
      {/* The named detail chip is already readable; its description completes
          the otherwise short provenance label for assistive technology. */}
      <span className="sr-only">{`: ${badge.description}`}</span>
    </span>
  )
}
