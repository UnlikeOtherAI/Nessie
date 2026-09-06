/**
 * Getting somebody back to the tenant address they started from.
 *
 * Sign-in cannot happen on a tenant hostname: UOA matches OAuth redirect URLs
 * byte-for-byte and tenant hostnames are created at runtime, so they can never
 * be registered targets. A visitor on `design.acme.nessie.works` is therefore
 * handed to the product's canonical origin — and without this, that is where
 * they stayed. They signed in and landed on someone's generic `/channels`,
 * having asked for a specific tenant address.
 *
 * The return address travels as a query parameter (it has to: sessionStorage is
 * per origin, so nothing written on the tenant host is readable on the
 * canonical one), and is then held on the canonical origin across the OAuth
 * round trip, which replaces the query with the provider's own.
 *
 * Because it arrives in a URL, anyone can put anything in it. It is checked
 * twice before it is ever stored: the shape here, and then — by the caller —
 * against `/api/hosts/resolve`, which answers only for hostnames that really
 * are tenants of this deployment. A host that does not resolve is not stored,
 * so the value read back at redirect time has already been vouched for and the
 * redirect itself needs no further judgement.
 */

export const TENANT_RETURN_PARAM = 'return'

const STORAGE_KEY = 'nessie.tenant-return'

/**
 * The shape check: what could plausibly be one of our tenant addresses.
 *
 * Deliberately strict about `https:` — an `http:` return would hand a fresh
 * session to a downgraded connection — and about credentials in the URL, which
 * are never something this product produces.
 */
export const parseTenantReturn = (raw: string | null, currentOrigin: string): URL | null => {
  if (!raw) return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  // Already here. Sending somebody to the origin they are on is at best a
  // wasted navigation and at worst a loop.
  if (url.origin === currentOrigin) return null

  return url
}

const storage = (): Storage | null => {
  try {
    return window.sessionStorage
  } catch {
    // Private modes and blocked site data throw on access, not on use.
    return null
  }
}

export const rememberTenantReturn = (href: string): void => {
  try {
    storage()?.setItem(STORAGE_KEY, href)
  } catch {
    // Nothing to do: the person simply lands on the canonical origin instead.
  }
}

export const readTenantReturn = (): string | null => {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? null
  } catch {
    return null
  }
}

export const forgetTenantReturn = (): void => {
  try {
    storage()?.removeItem(STORAGE_KEY)
  } catch {
    // Ignored for the same reason as above.
  }
}
