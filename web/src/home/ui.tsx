type ButtonProps = { href: string; ghost?: boolean; light?: boolean; children: string }

export function Button({ href, ghost = false, light = false, children }: ButtonProps) {
  const classes = ['n-btn', ghost && 'n-btn-ghost', light && 'n-btn-light'].filter(Boolean).join(' ')
  return (
    <a className={classes} href={href}>
      {children}
    </a>
  )
}

// Fired by the footer's "Cookie preferences" link; the cookie bar listens.
export const openCookieEvent = 'nessie:open-cookie-preferences'
