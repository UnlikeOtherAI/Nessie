import type { ReactNode } from 'react'
import { useIsOwner } from '../../facades/auth/hooks'

/**
 * "Owner access required" — one sentence, one derivation.
 *
 * Five owner-only pages (Audit Log, Policy, Triggers, Tools, Operational
 * usage) rendered that sentence in byte-identical markup, and
 * `roleIds.includes('owner')` was re-derived at 26 call sites across the
 * admin. The refusal lives here so it cannot drift into five different
 * wordings; the derivation itself is the session's, and lives with the
 * session in `facades/auth/hooks.ts` (`isOwnerSession`/`useIsOwner`) so a
 * facade can gate a query on it without importing a component.
 *
 * The gate is a *render* gate, not an authorization boundary: a page that
 * gates its queries with `enabled: isOwner` keeps doing so through
 * `useIsOwner()`, because wrapping the render must never let a request go out
 * for someone who could not make it before. The server re-checks either way.
 */

type OwnerGateProps = {
  children?: ReactNode
}

export const OwnerGate = ({ children }: OwnerGateProps) => {
  const isOwner = useIsOwner()

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  return <>{children}</>
}
