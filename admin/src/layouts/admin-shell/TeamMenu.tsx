import { useMemo, type RefObject } from 'react'
import { faCheck, faPlus, faSpinner } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { UoaPendingTeamInvite } from '@nessie/schemas'

import { Popover } from '../../components/overlays/Popover'
import { TeamAvatar } from '../../components/primitives/TeamAvatar'
import {
  orderTeamsWithActiveFirst,
  type Team,
} from '../../lib/teams'

type TeamMenuProps = {
  anchorRef: RefObject<HTMLElement | null>
  teams: Team[]
  activeTeamId: string | null
  ssoProviderId: string | null
  busyTeamId: string | null
  busyInviteId: string | null
  error: string | null
  invitations: UoaPendingTeamInvite[]
  token: string | null
  avatarRevision: number
  open: boolean
  onSelect: (team: Team) => void
  onAcceptInvitation: (invite: UoaPendingTeamInvite) => void
  onAddTeam: (providerId: string) => void
  onClose: () => void
}

// The rail's team list opens beside its trigger. Width is the menu's own
// design constraint — a long organisation name needs room, but never more than
// four fifths of a narrow window — and is stated in CSS so no code re-reads the
// viewport for it. Everything about *where* it lands (the flip when the rail
// button sits near the bottom, the clamp against a short window) belongs to the
// one Popover placement helper.
const MENU_WIDTH = 'min(390px, 80vw)'

const panelClassName = [
  'overflow-y-auto rounded-xl border',
  'border-[color:var(--sep)] bg-[color:var(--panel)] p-1.5',
  'shadow-[0_16px_48px_var(--scrim-strong)]',
].join(' ')

export const TeamMenu = ({
  anchorRef,
  teams,
  activeTeamId,
  ssoProviderId,
  busyTeamId,
  busyInviteId,
  error,
  invitations,
  token,
  avatarRevision,
  open,
  onSelect,
  onAcceptInvitation,
  onAddTeam,
  onClose,
}: TeamMenuProps) => {
  const orderedTeams = useMemo(
    () => orderTeamsWithActiveFirst(teams, activeTeamId),
    [activeTeamId, teams],
  )
  return (
    <Popover
      anchorRef={anchorRef}
      className={panelClassName}
      label="Teams"
      onClose={onClose}
      open={open}
      placement="right"
      role="menu"
      style={{ width: MENU_WIDTH }}
    >
      {/* SectionLabel cannot express tracking-[0.18em] at text-xs (xs is 0.2em, 2xs is 11px). */}
      <div className="flex items-center justify-between gap-3 px-2 py-1">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
          Teams
        </div>
        {ssoProviderId ? (
          <button
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-semibold text-[color:var(--accent)] transition-colors hover:bg-[color:var(--overlay-weak)] disabled:opacity-60"
            disabled={busyTeamId !== null || busyInviteId !== null}
            onClick={() => onAddTeam(ssoProviderId)}
            type="button"
          >
            <FontAwesomeIcon aria-hidden className="h-3 w-3" icon={faPlus} />
            Add team
          </button>
        ) : null}
      </div>
      {orderedTeams.map((team) => {
        const isActive = team.active || team.teamId === activeTeamId
        const isBusy = team.teamId === busyTeamId
        const organizationName = team.orgName?.trim()
        return (
          <button
            aria-busy={isBusy}
            aria-label={organizationName ? `${team.label}, ${organizationName}` : team.label}
            className={[
              'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
              'hover:bg-[color:var(--overlay-weak)] disabled:opacity-60',
            ].join(' ')}
            disabled={busyTeamId !== null || busyInviteId !== null}
            key={team.teamId}
            onClick={() => onSelect(team)}
            type="button"
          >
            <TeamAvatar
              imageUrl={team.avatarImageUrl}
              label={team.label}
              revision={isActive ? avatarRevision : 0}
              size={32}
              teamId={team.uoaTeam ? team.avatarTeamId ?? null : team.teamId}
              token={token}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-[color:var(--tx)]">{team.label}</span>
              {organizationName ? (
                <span className="block truncate text-xs text-[color:var(--tx3)]">{organizationName}</span>
              ) : null}
            </span>
            {isBusy ? (
              <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" icon={faSpinner} spin />
            ) : isActive ? (
              <FontAwesomeIcon className="h-3.5 w-3.5 text-[color:var(--accent)]" icon={faCheck} />
            ) : null}
          </button>
        )
      })}

      {invitations.length > 0 ? (
        <div className="mt-1 border-t border-[color:var(--sep)] pt-1">
          <div className="px-2 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[color:var(--tx3)]">
            Invitations
          </div>
          {invitations.map((invite) => {
            const isBusy = invite.inviteId === busyInviteId
            return (
              <div className="flex items-center gap-3 rounded-lg px-2 py-2" key={invite.inviteId}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-[color:var(--tx)]">{invite.teamName}</span>
                  {invite.invitedBy ? (
                    <span className="block truncate text-xs text-[color:var(--tx3)]">
                      Invited by {invite.invitedBy}
                    </span>
                  ) : null}
                </span>
                <button
                  aria-busy={isBusy}
                  className="rounded-md bg-[color:var(--accent)] px-2 py-1 text-xs font-semibold text-[color:var(--on-accent)] disabled:opacity-60"
                  disabled={busyTeamId !== null || busyInviteId !== null}
                  onClick={() => onAcceptInvitation(invite)}
                  type="button"
                >
                  {isBusy ? 'Accepting…' : 'Accept'}
                </button>
              </div>
            )
          })}
        </div>
      ) : null}

      {error ? (
        <div
          className="mx-2 my-2 rounded-lg bg-[color:var(--danger-soft)] px-2.5 py-2 text-xs text-[color:var(--danger-text)]"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </Popover>
  )
}
