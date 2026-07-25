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
import { sectionTitleClass } from '../settings-shared'

const ADMIN_ROLES = new Set(['owner', 'admin'])

// UnlikeOtherAI's own upload rules, enforced here only so an obvious mistake is
// caught before a round trip. UOA decides the real type by magic-byte sniffing.
const MAX_BYTES = 1024 * 1024
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

/**
 * The company avatar UnlikeOtherAI holds for this workspace — the picture every
 * UOA surface shows for the team, distinct from the Nessie-side organisation
 * logo above it. Owners and admins can replace or clear it; everyone else sees
 * the preview only.
 */
export const WorkspaceAvatarPanel = () => {
  const { me, token } = useAuthSession()
  const { data: organization } = useCurrentOrganization()
  const revision = useWorkspaceAvatarRevision()
  const uploadAvatar = useUploadWorkspaceAvatar()
  const removeAvatar = useRemoveWorkspaceAvatar()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const workspaceName =
    activeWorkspace(me)?.label ?? organization?.name ?? 'Workspace'
  const canEdit = organization ? ADMIN_ROLES.has(organization.role) : false
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
    <section className="admin-card max-w-3xl p-4">
      <div className={sectionTitleClass}>Workspace avatar</div>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        The company picture for {workspaceName}, held by UnlikeOtherAI and shown
        anywhere the workspace appears. Separate from the organisation logo above,
        which is Nessie&rsquo;s own brand mark.
      </div>

      <div className="mt-4 flex items-center gap-5">
        <WorkspaceAvatar
          className="border border-[color:var(--sep)]"
          label={workspaceName}
          revision={revision}
          size={96}
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
            Only organisation owners and admins can change the workspace avatar.
          </div>
        )}
      </div>

      {error && <div className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</div>}
      {notice && !error && (
        <div className="mt-3 text-sm text-[color:var(--tx2)]">{notice}</div>
      )}
    </section>
  )
}
