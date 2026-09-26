import type { ReactNode } from 'react'

import { Notice } from '../../primitives/Notice'
import { SettingsPanel, type SettingsTabHostProps } from '../../shared/SettingsPanel'
import type { AdminScopeResolution } from '../../../lib/admin-scope'

type PendingResolution = Exclude<AdminScopeResolution, { status: 'ready' }>

type AdminScopeNoticeProps = {
  host: SettingsTabHostProps
  /** What the page says to somebody for whom none of its scopes is theirs. */
  refusal: ReactNode
  resolution: PendingResolution
  title: string
}

const body = (resolution: PendingResolution, refusal: ReactNode): ReactNode => {
  switch (resolution.status) {
    case 'loading':
    case 'landing':
      return <p className="text-sm text-[color:var(--tx3)]">Loading…</p>
    case 'failed':
      return <Notice tone="danger">Teams could not be loaded. Try again in a moment.</Notice>
    case 'refused':
      return <div className="text-sm text-[color:var(--tx2)]">{refusal}</div>
    case 'unavailable':
      return (
        <Notice tone="info">
          {`${resolution.option.unavailableReason ?? ''} Choose another scope above.`}
        </Notice>
      )
    case 'unknown':
      return (
        <Notice tone="warning">
          This address names a team that isn’t in your organisation, or one you can’t open here.
          Choose a scope above.
        </Notice>
      )
  }
}

/**
 * Everything a scoped Organisation page shows before it has a scope to show:
 * loading, the landing redirect, a refusal, and an address naming a scope the
 * viewer may not use or one that does not exist. Each keeps the page's header
 * and its switch, so the way to a real scope stays on screen.
 */
export const AdminScopeNotice = ({ host, refusal, resolution, title }: AdminScopeNoticeProps) => (
  <SettingsPanel eyebrow="Organisation" host={host} title={title}>
    {body(resolution, refusal)}
  </SettingsPanel>
)
