import { useRef, useState } from 'react'
import { WorkspaceAvatar } from '../../../components/primitives/WorkspaceAvatar'
import { useCurrentOrganization } from '../../../facades/organization/hooks'
import {
  useRemoveWorkspaceAvatar,
  useUploadWorkspaceAvatar,
  useWorkspaceAvatarRevision,
} from '../../../facades/workspace/hooks'
import { activeWorkspace } from '../../../lib/workspaces'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Card } from '../../../components/shared/Card'
import { FormError, FormSuccess } from '../../../components/shared/FormActions'

const ADMIN_ROLES = new Set(['owner', 'admin'])

// UnlikeOtherAI's own upload rules, enforced here only so an obvious mistake is
// caught before a round trip. UOA decides the real type by magic-byte sniffing.
const MAX_BYTES = 1024 * 1024
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

type WorkspaceAvatarPanelProps = {
  /**
   * The workspace this panel is showing, when the screen lets a person pick one
   * that is not the one they are in. Omitted means the current workspace.
   */
  team?: { id: string; name: string } | undefined
}

/**
 * The company avatar UnlikeOtherAI holds for this workspace — the picture every
 * UOA surface shows for the team, distinct from the Nessie-side organisation
 * logo on the organisation's own Profile screen. Owners and admins can replace
 * or clear it; everyone else sees the preview only.
 *
 * The mutations always address the *current* workspace, because UOA authorizes
 * them as the signed-in person inside it and refuses an assertion pointed at
 * any other one. So when the screen's picker is showing a different workspace
 * this panel previews that workspace's picture through the membership-scoped
 * relay and withholds the controls, rather than silently editing the picture of
 * the workspace the person happens to be standing in.
 */
export const WorkspaceAvatarPanel = ({ team }: WorkspaceAvatarPanelProps = {}) => {
  const { me, token } = useAuthSession()
  const { data: organization } = useCurrentOrganization()
  const revision = useWorkspaceAvatarRevision()
  const uploadAvatar = useUploadWorkspaceAvatar()
  const removeAvatar = useRemoveWorkspaceAvatar()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const workspace = activeWorkspace(me)
  const active = !team || team.id === me?.context.teamId
  const workspaceName = active
    ? workspace?.label ?? organization?.name ?? 'Workspace'
    : team?.name ?? 'Workspace'
  const canEdit = active && (organization ? ADMIN_ROLES.has(organization.role) : false)
  const busy = uploadAvatar.isPending || removeAvatar.isPending

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setNotice(null)

    if (!ACCEPTED_TYPES.has(file.type)) {
      setError('Choose a PNG, JPEG or WebP image.')
      return
    }
    if (file.size > MAX_BYTES) {
      setError('The image must be under 1 MB.')
      return
    }

    try {
      await uploadAvatar.mutateAsync(file)
      setNotice('Workspace avatar updated.')
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : 'Failed to save the avatar',
      )
    }
  }

  const handleRemove = async () => {
    setError(null)
    setNotice(null)
    try {
      await removeAvatar.mutateAsync()
      setNotice('Workspace avatar removed.')
    } catch (removeError) {
      setError(
        removeError instanceof Error ? removeError.message : 'Failed to remove the avatar',
      )
    }
  }

  return (
    <Card as="section">
      <SectionLabel>Workspace avatar</SectionLabel>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        The company picture for {workspaceName}, held by UnlikeOtherAI and shown
        anywhere the workspace appears &mdash; including in every other
        UnlikeOtherAI product. Separate from the organisation logo, which is the
        whole tenant&rsquo;s brand mark.
      </div>

      <div className="mt-4 flex items-center gap-5">
        {/*
          The same three-step resolution the sidebar switcher uses — Nessie's
          authenticated relay, then UOA's public team image, then initials — so
          this panel shows the picture people are actually looking at. Passing
          only the relay drew initials here while the rail showed the workspace's
          real SSO icon, which read as "there is no picture" next to a Remove
          button.
        */}
        <WorkspaceAvatar
          className="border border-[color:var(--sep)]"
          imageUrl={active ? workspace?.avatarImageUrl : undefined}
          label={workspaceName}
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
                {uploadAvatar.isPending ? 'Uploading…' : 'Upload image'}
              </button>
              <button
                className="admin-button admin-button-secondary"
                disabled={busy}
                onClick={() => void handleRemove()}
                type="button"
              >
                {removeAvatar.isPending ? 'Removing…' : 'Remove'}
              </button>
            </div>
            <div className="text-xs text-[color:var(--tx3)]">
              PNG, JPEG or WebP, up to 1 MB. Square images work best. Removing it
              falls back to the workspace icon or a generated image.
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
              ? 'Only organisation owners and admins can change the workspace avatar.'
              : 'UnlikeOtherAI only accepts this change from inside the workspace. '
                + 'Switch to it to change its picture.'}
          </div>
        )}
      </div>

      <FormError className="mt-3">{error}</FormError>
      {!error ? <FormSuccess className="mt-3">{notice}</FormSuccess> : null}
    </Card>
  )
}
