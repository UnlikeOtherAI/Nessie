import type { IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'

type ButtonProps = { href: string; ghost?: boolean; light?: boolean; icon?: IconDefinition; children: string }

export function Button({ href, ghost = false, light = false, icon, children }: ButtonProps) {
  const classes = ['n-btn', ghost && 'n-btn-ghost', light && 'n-btn-light'].filter(Boolean).join(' ')
  return (
    <a className={classes} href={href}>
      {icon && <FontAwesomeIcon aria-hidden="true" className="n-btn-icon" icon={icon} />}
      {children}
    </a>
  )
}

// Fired by the footer's "Cookie preferences" link; the cookie bar listens.
export const openCookieEvent = 'nessie:open-cookie-preferences'
