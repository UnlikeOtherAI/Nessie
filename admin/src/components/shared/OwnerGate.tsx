import type { ReactNode } from 'react'
import type { MeResponse } from '@nessie/schemas'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * "Owner access required" — one sentence, one derivation.
 *
 * Five owner-only pages (Audit Log, Policy, Triggers, Tools, Operational
 * usage) rendered that sentence in byte-identical markup, and
 * `roleIds.includes('owner')` was re-derived at 26 call sites across the
 * admin. Both halves now come from here, so the refusal cannot drift into
 * five different wordings and the question "is this person an owner?" has one
 * answer.
 *
 * The gate is a *render* gate, not an authorization boundary: a page that
 * gates its queries with `enabled: isOwner` keeps doing so through
 * `useIsOwner()`, because wrapping the render must never let a request go out
 * for someone who could not make it before. The server re-checks either way.
 */

/**
 * The derivation itself, over a session that may not exist yet. A signed-out
 * session is not an owner — the `?? false` every call site carried.
 *
 * `roleIds` is dereferenced without a second `?.`, matching 25 of the 29
 * call sites this replaces. Four disagreed (`roleIds?.includes`), and that
 * chain was unreachable defence rather than a guard someone needs back: all
 * four render inside `AdminShellLayout`, whose `useAdminShell` reads
 * `me?.user.roleIds.includes('owner')` *unguarded* on the same object before
 * any of them mounts. A session that could reach them with no `roleIds` has
 * already crashed one level up. Nothing feeds a partial session either — the
 * provider persists only the bearer token and re-fetches `me` from
 * `/api/auth/me` on every mount, and the debug-session import deliberately
 * discards the pasted user and re-fetches too. The field is required by
 * `MeUserSchema` and set unconditionally by `buildMeResponse`.
 */
export const isOwnerSession = (me: MeResponse | null): boolean =>
  me?.user.roleIds.includes('owner') ?? false

/** The same question, asked from a component or a hook. */
export const useIsOwner = (): boolean => isOwnerSession(useAuthSession().me)

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
