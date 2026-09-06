import type { ReactNode } from 'react'

import type { TenantOrganisation } from '../../facades/team/tenant-host'
import { TENANT_RETURN_PARAM } from '../../lib/tenant-return'

/**
 * The tenant's own face, shared by every page served on a tenant hostname.
 *
 * Both the organisation portal and a team address show the same thing above the
 * fold — the customer's mark, their name, and the address the visitor typed —
 * because on those hostnames the product is not the brand; the tenant is. What
 * differs is only what sits underneath, so that part is a child.
 */

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('') || '?'

export const OrgMark = ({ org, size }: { org: TenantOrganisation; size: number }) => {
  if (org.iconUrl) {
    return (
      <img
        alt=""
        className="rounded-[var(--radius-lg)] object-cover"
        height={size}
        src={org.iconUrl}
        width={size}
      />
    )
  }
  return (
    <div
      aria-hidden
      className={[
        'flex items-center justify-center rounded-[var(--radius-lg)]',
        'bg-[color:var(--accent)] font-semibold text-[color:var(--accent-tx)]',
      ].join(' ')}
      style={{ height: size, width: size, fontSize: Math.round(size / 2.6) }}
    >
      {initialsOf(org.name)}
    </div>
  )
}

/**
 * Send somebody to sign in, and bring them back to the address they opened.
 *
 * Sign-in cannot happen on the tenant hostname itself: UOA matches OAuth
 * redirect URLs byte-for-byte and tenant hostnames are created at runtime, so
 * they can never be registered targets. The visitor goes to the product's
 * canonical origin and returns here afterwards, which is why `return` carries
 * the full current URL rather than just a path.
 */
export const startTenantSignIn = (signInOrigin: string | null): void => {
  const target = signInOrigin?.replace(/\/+$/, '')
  // Without a configured canonical origin there is nowhere safe to send
  // somebody, so fall back to this host's own login route rather than guessing.
  if (!target) {
    window.location.href = '/login'
    return
  }
  const back = encodeURIComponent(window.location.href)
  window.location.href = `${target}/login?${TENANT_RETURN_PARAM}=${back}`
}

export const TenantBrandFrame = ({
  organisation,
  children,
}: {
  organisation: TenantOrganisation
  children: ReactNode
}) => (
  <main
    className={[
      'flex min-h-screen flex-col items-center justify-center gap-6',
      'bg-[color:var(--main)] px-6 py-12 text-[color:var(--tx)]',
    ].join(' ')}
  >
    <div className="flex flex-col items-center gap-4 text-center">
      <OrgMark org={organisation} size={72} />
      <div>
        <h1 className="text-xl font-semibold">{organisation.name}</h1>
        <p className="mt-1 text-sm text-[color:var(--tx3)]">{window.location.hostname}</p>
      </div>
    </div>
    {children}
  </main>
)

export const TenantSignInButton = ({ signInOrigin }: { signInOrigin: string | null }) => (
  <button
    className={[
      'rounded-[var(--radius-md)] bg-[color:var(--accent)] px-5 py-2.5',
      'text-sm font-medium text-[color:var(--accent-tx)]',
    ].join(' ')}
    onClick={() => startTenantSignIn(signInOrigin)}
    type="button"
  >
    Sign in
  </button>
)
