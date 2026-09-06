import type { ReactNode } from 'react'
import type { MeResponse } from '@nessie/schemas'
import { useAuthSession } from '../../providers/AuthSessionProvider'

/**
 * "Instance super-admin access required" — one sentence, one derivation,
 * mirroring `OwnerGate.tsx`'s shape one tier up.
 *
 * `/ops` reads deployment-wide worker, queue and dead-job state that has no
 * tenant column, so it is gated on the named instance-wide role rather than
 * on being an owner of some organisation. Before this, `OpsHealthPage` asked
 * that question inline (`me?.user.superAdmin ?? false`) with its own bespoke
 * refusal markup — the exact "is this person an owner" duplication
 * `OwnerGate` was built to end, repeating one tier up
 * (docs/plans/2026-09-05-admin-architecture-review/audit/05-pages-routing.md
 * F6).
 *
 * Like `OwnerGate`, this is a *render* gate, not an authorization boundary: a
 * page that gates its queries with `enabled: isSuperAdmin` keeps doing so
 * through `useIsSuperAdmin()`, and the server re-checks either way.
 */

export const isSuperAdminSession = (me: MeResponse | null): boolean =>
  me?.user.superAdmin ?? false

/** The same question, asked from a component or a hook. */
export const useIsSuperAdmin = (): boolean => isSuperAdminSession(useAuthSession().me)

type SuperAdminGateProps = {
  children?: ReactNode
}

export const SuperAdminGate = ({ children }: SuperAdminGateProps) => {
  const isSuperAdmin = useIsSuperAdmin()

  if (!isSuperAdmin) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Instance super-admin access required
      </section>
    )
  }

  return <>{children}</>
}
