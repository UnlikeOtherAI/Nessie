/**
 * The controlled icon vocabulary for stat cards.
 *
 * A widget stores only a schema-owned identifier. The mapping to an imported
 * Font Awesome Free definition stays here, which keeps external configuration
 * from selecting an icon package, class name, SVG path, or arbitrary markup.
 */

import {
  faBolt,
  faCartShopping,
  faChartLine,
  faCircleCheck,
  faClock,
  faDatabase,
  faDollarSign,
  faServer,
  faTriangleExclamation,
  faUsers,
  type IconDefinition,
} from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { DashboardMetricIcon as DashboardMetricIconId } from '@nessie/schemas'

const ICONS: Record<DashboardMetricIconId, IconDefinition> = {
  chart: faChartLine,
  users: faUsers,
  revenue: faDollarSign,
  cart: faCartShopping,
  clock: faClock,
  server: faServer,
  database: faDatabase,
  bolt: faBolt,
  check: faCircleCheck,
  warning: faTriangleExclamation,
}

export const DASHBOARD_METRIC_ICON_LABELS: Record<DashboardMetricIconId, string> = {
  chart: 'Chart',
  users: 'Users',
  revenue: 'Revenue',
  cart: 'Cart',
  clock: 'Clock',
  server: 'Server',
  database: 'Database',
  bolt: 'Bolt',
  check: 'Check',
  warning: 'Warning',
}

export const DashboardMetricIcon = ({
  icon,
  className,
}: {
  icon: DashboardMetricIconId
  className?: string
}) => (
  <FontAwesomeIcon aria-hidden className={className} icon={ICONS[icon]} />
)
