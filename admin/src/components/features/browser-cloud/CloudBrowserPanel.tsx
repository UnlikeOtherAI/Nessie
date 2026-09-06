import { useState } from 'react'

import type { CloudBrowserConnectionRecord, CloudBrowserScope } from '../../../lib/api-client'
import {
  useCloudBrowserConnections,
  useDisconnectCloudBrowser,
} from '../../../facades/browser-cloud/hooks'
import { Pill } from '../../primitives/Pill'
import { SectionLabel } from '../../primitives/SectionLabel'
import { ConfirmDialog } from '../../shared/ConfirmDialog'
import { FormError } from '../../shared/FormActions'
import { BrowserHomepageField } from './BrowserHomepageField'
import { CloudBrowserConnectionForm } from './CloudBrowserConnectionForm'
import {
  SETTING_KEYS,
  settingFor,
  useScopedSettings,
  useWriteScopedSetting,
} from '../../../facades/settings/hooks'
import { ScopedSettingGate, ScopedSettingLock } from '../settings/ScopedSettingGate'

type CloudBrowserPanelProps = {
  scope: CloudBrowserScope
  /** Required at team scope: which team's account this is. */
  teamId?: string | null
}

const HEALTH_COPY: Record<string, string> = {
  auth_failed: 'Browserbase rejected the stored key. Replace it to start browsing again.',
  unreachable: 'Browserbase could not be reached the last time an agent tried.',
  disabled_by_owner: 'Switched off for this team.',
}

const SCOPE_COPY: Record<CloudBrowserScope, { title: string; blurb: string; empty: string }> = {
  organization: {
    title: 'Company account',
    blurb:
      'Connect the organisation’s Browserbase account. Every agent granted the browser '
      + 'tools can then open a browser, for anyone who asks them to.',
    empty: 'No company account is connected, so only people with their own account can browse.',
  },
  team: {
    title: 'Team account',
    blurb:
      'Connect a Browserbase account for this team. It sits between the company account '
      + 'and people’s own, and agents working for this team use it by default.',
    empty:
      'No team account is connected, so this team falls back to the company account or to '
      + 'people’s own.',
  },
  user: {
    title: 'Your account',
    blurb:
      'Connect your own Browserbase account. It powers only the runs you start, and the '
      + 'free tier is enough to try this out.',
    empty: 'Connect your own account to let your agents browse before the company subscribes.',
  },
}

/**
 * One panel, three homes: the owner-only company account on organisation
 * settings, a team's on its own, and a person's on their connections page.
 *
 * One component rather than three because everything it carries — the
 * connection, the lock that stops a level below overriding it, the home page —
 * cascades the same way, and a second copy of that reasoning is how the levels
 * drift apart.
 */
export const CloudBrowserPanel = ({ scope, teamId = null }: CloudBrowserPanelProps) => {
  const connections = useCloudBrowserConnections()
  const disconnect = useDisconnectCloudBrowser()
  // Both browser keys in one request: they are drawn a few centimetres apart
  // at the same level, and a second query would resolve the same cascade again.
  const settings = useScopedSettings(
    scope,
    [SETTING_KEYS.browserConnection, SETTING_KEYS.browserHomepage],
    teamId,
  )
  const writeSetting = useWriteScopedSetting()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const copy = SCOPE_COPY[scope]
  const setting = settingFor(settings.data, SETTING_KEYS.browserConnection)
  const homepageSetting = settingFor(settings.data, SETTING_KEYS.browserHomepage)
  const rows: CloudBrowserConnectionRecord[] = connections.data?.connections ?? []
  const connection = rows.find((row) =>
    scope === 'organization' ? row.scope === 'organization'
    : scope === 'team' ? row.scope === 'team'
    : row.scope === 'user' && row.isMine)

  const setLock = (locked: boolean) => {
    setError(null)
    writeSetting.mutate(
      { key: SETTING_KEYS.browserConnection, locked, scope, teamId, value: null },
      {
        onError: (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : 'Could not save that.'),
      },
    )
  }

  const remove = () => {
    if (!connection) return
    setError(null)
    disconnect.mutate(connection.id, {
      onError: (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Could not disconnect.')
        setConfirming(false)
      },
      onSuccess: () => setConfirming(false),
    })
  }

  return (
    <section className="admin-card p-4" id={`cloud-browsers-${scope}`}>
      <SectionLabel>{scope === 'user' ? 'Browser' : 'Cloud browsers'}</SectionLabel>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="font-semibold text-[color:var(--tx)]">{copy.title}</h2>
          {connections.isLoading ? (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">Loading…</p>
          ) : connection ? (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">
              {connection.projectId ? (
                <>Project <span className="font-mono">{connection.projectId}</span></>
              ) : 'Connected'}
              {connection.usedMinutes > 0
                ? ` · ${connection.usedMinutes} browser minute${connection.usedMinutes === 1 ? '' : 's'} used`
                : ' · no browser time used yet'}
              {connection.liveSessions > 0
                ? ` · ${connection.liveSessions} open now`
                : ''}
            </p>
          ) : (
            <p className="mt-1 text-sm text-[color:var(--tx2)]">{copy.empty}</p>
          )}
          {connection && connection.status !== 'active' ? (
            <p className="mt-2 text-sm text-[color:var(--danger)]">
              {HEALTH_COPY[connection.healthReason ?? ''] ?? 'This connection needs attention.'}
            </p>
          ) : null}
        </div>
        {connection ? (
          <Pill tone={connection.status === 'active' ? 'success' : 'warning'}>
            {connection.status === 'active' ? 'Connected' : 'Needs attention'}
          </Pill>
        ) : null}
      </div>

      <ScopedSettingGate setting={setting}>
        <CloudBrowserConnectionForm
          blurb={copy.blurb}
          connected={Boolean(connection)}
          scope={scope}
          teamId={teamId}
        />
      </ScopedSettingGate>

      {setting?.canEdit && scope !== 'user' ? (
        <div className="mt-4 border-t border-[color:var(--sep)] pt-3">
          <ScopedSettingLock
            disabled={writeSetting.isPending}
            locked={setting.lockedHere}
            onChange={setLock}
            scope={scope}
          />
        </div>
      ) : null}

      <BrowserHomepageField scope={scope} setting={homepageSetting} teamId={teamId} />

      {connection ? (
        <div className="mt-4 border-t border-[color:var(--sep)] pt-3">
          <button
            className="admin-button admin-button-danger admin-button-compact"
            disabled={disconnect.isPending}
            onClick={() => setConfirming(true)}
            type="button"
          >
            Disconnect
          </button>
          <p className="mt-2 text-xs text-[color:var(--tx3)]">
            Disconnecting deletes the stored key. Any browsers still open must be closed
            first, because nothing could tell Browserbase to stop them afterwards.
          </p>
        </div>
      ) : null}

      <FormError className="mt-3">{error}</FormError>

      <ConfirmDialog
        body="Agents will not be able to open a browser through this account until a key is connected again."
        confirmLabel="Disconnect"
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={remove}
        open={confirming}
        pending={disconnect.isPending}
        title="Disconnect this Browserbase account?"
      />
    </section>
  )
}
