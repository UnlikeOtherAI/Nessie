import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TeamAvatar } from '../../../components/primitives/TeamAvatar'
import { useCurrentOrganization } from '../../../facades/organization/hooks'
import {
  useRemoveTeamAvatar,
  useUploadTeamAvatar,
  useTeamAvatarRevision,
} from '../../../facades/team/hooks'
import { activeTeam } from '../../../lib/teams'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Card } from '../../../components/shared/Card'
import { FormError, FormSuccess } from '../../../components/shared/FormActions'

const ADMIN_ROLES = new Set(['owner', 'admin'])

// UnlikeOtherAI's own upload rules, enforced here only so an obvious mistake is
// caught before a round trip. UOA decides the real type by magic-byte sniffing.
const MAX_BYTES = 1024 * 1024
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type TeamAvatarPanelProps = {
  /**
   * The team this panel is showing, when the screen lets a person pick one
   * that is not the one they are in. Omitted means the current team.
   */
  team?: { id: string; name: string } | undefined
}

/**
 * The company avatar UnlikeOtherAI holds for this team — the picture every
 * UOA surface shows for the team, distinct from the Nessie-side organisation
 * logo on the organisation's own Profile screen. Owners and admins can replace
 * or clear it; everyone else sees the preview only.
 *
 * The mutations always address the *current* team, because UOA authorizes
 * them as the signed-in person inside it and refuses an assertion pointed at
 * any other one. So when the screen's picker is showing a different team
 * this panel previews that team's picture through the membership-scoped
 * relay and withholds the controls, rather than silently editing the picture of
 * the team the person happens to be standing in.
 */
export const TeamAvatarPanel = ({ team }: TeamAvatarPanelProps = {}) => {
  const { t } = useTranslation('settings')
  const { me, token } = useAuthSession()
  const { data: organization } = useCurrentOrganization()
  const revision = useTeamAvatarRevision()
  const uploadAvatar = useUploadTeamAvatar()
  const removeAvatar = useRemoveTeamAvatar()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const currentTeam = activeTeam(me)
  const active = !team || team.id === me?.context.teamId
  const teamName = active
    ? currentTeam?.label ?? organization?.name ?? t('team.team')
    : team?.name ?? t('team.team')
  const canEdit = active && (organization ? ADMIN_ROLES.has(organization.role) : false)
  const busy = uploadAvatar.isPending || removeAvatar.isPending

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setNotice(null)

    if (!ACCEPTED_TYPES.has(file.type)) {
      setError(t('team.avatarTypeError'))
      return
    }
    if (file.size > MAX_BYTES) {
      setError(t('team.avatarSizeError'))
      return
    }

    try {
      await uploadAvatar.mutateAsync(file)
      setNotice(t('team.avatarUpdated'))
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : t('team.avatarSaveFailed'),
      )
    }
  }

  const handleRemove = async () => {
    setError(null)
    setNotice(null)
    try {
      await removeAvatar.mutateAsync()
      setNotice(t('team.avatarRemoved'))
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : t('team.avatarRemoveFailed'),
      )
    }
  }

  return (
    <Card as="section">
      <SectionLabel>{t('team.avatar')}</SectionLabel>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        {t('team.avatarDescription', { team: teamName })}
      </div>

      <div className="mt-4 flex items-center gap-5">
        {/*
          The same three-step resolution the sidebar switcher uses — Nessie's
          authenticated relay, then UOA's public team image, then initials — so
          this panel shows the picture people are actually looking at. Passing
          only the relay drew initials here while the rail showed the team's
          real SSO icon, which read as "there is no picture" next to a Remove
          button.
        */}
        <TeamAvatar
          className="border border-[color:var(--sep)]"
          imageUrl={active ? currentTeam?.avatarImageUrl : undefined}
          label={teamName}
          revision={revision}
          size={96}
          {...(active ? {} : { teamId: team?.id })}
          token={token}
        />

        {canEdit ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                className="admin-button admin-button-primary"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                {uploadAvatar.isPending ? t('team.uploading') : t('team.uploadImage')}
              </button>
              <button
                className="admin-button admin-button-secondary"
                disabled={busy}
                onClick={() => void handleRemove()}
                type="button"
              >
                {removeAvatar.isPending ? t('team.removing') : t('common.remove')}
              </button>
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              {t('team.avatarFileHint')}
            </div>
            <input
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => void handleFileChange(event)}
              ref={inputRef}
              type="file"
            />
          </div>
        ) : (
          <div className="text-sm text-[color:var(--tx3)]">
            {active
              ? t('team.avatarOwnerOnly')
              : t('team.avatarActiveTeamOnly')}
          </div>
        )}
      </div>

      <FormError className="mt-3">{error}</FormError>
      {!error ? <FormSuccess className="mt-3">{notice}</FormSuccess> : null}
    </Card>
  )
}
