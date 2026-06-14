import { useRef, useState } from 'react'
import {
  useCurrentOrganization,
  useUpdateOrganizationLogo,
} from '../../../facades/organization/hooks'
import { getInitials } from '../../../lib/avatar'
import { uploadAttachment, useAuthedObjectUrl } from '../../../lib/uploads'
import { CircleImageCropper } from '../../../components/shared/CircleImageCropper'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { sectionTitleClass } from '../settings-shared'

const ADMIN_ROLES = new Set(['owner', 'admin'])

export const LogoPanel = () => {
  const { token } = useAuthSession()
  const { data: organization, isLoading } = useCurrentOrganization()
  const updateLogo = useUpdateOrganizationLogo()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const logoUrl = useAuthedObjectUrl(organization?.logoAttachmentId ?? null, token)
  const canEdit = organization ? ADMIN_ROLES.has(organization.role) : false
  const busy = uploading || updateLogo.isPending

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError(null)
    setSelectedFile(file)
  }

  const handleSave = async (blob: Blob) => {
    setUploading(true)
    setError(null)
    try {
      const file = new File([blob], 'logo.png', { type: 'image/png' })
      const attachment = await uploadAttachment(file, token)
      await updateLogo.mutateAsync(attachment.id)
      setSelectedFile(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save logo')
    } finally {
      setUploading(false)
    }
  }

  const handleRemove = () => {
    setError(null)
    updateLogo.mutate(null, {
      onError: (removeError) =>
        setError(removeError instanceof Error ? removeError.message : 'Failed to remove logo'),
    })
  }

  if (isLoading || !organization) {
    return (
      <section className="admin-card max-w-3xl p-4">
        <div className={sectionTitleClass}>Logo</div>
        <div className="mt-2 text-sm text-[color:var(--tx2)]">Loading…</div>
      </section>
    )
  }

  return (
    <section className="admin-card max-w-3xl p-4">
      <div className={sectionTitleClass}>Logo</div>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">
        A round logo for {organization.name}, shown in the sidebar and on the sign-in screen.
      </div>

      <div className="mt-4 flex items-center gap-5">
        <div
          className={[
            'flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full',
            'border border-[color:var(--sep)] bg-[color:var(--accent-soft)]',
            'text-2xl font-semibold text-[color:var(--accent)]',
          ].join(' ')}
        >
          {logoUrl ? (
            <img alt="Company logo" className="h-full w-full object-cover" src={logoUrl} />
          ) : (
            getInitials(organization.name)
          )}
        </div>

        {canEdit ? (
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button
                className="admin-button admin-button-primary"
                disabled={busy}
                onClick={() => inputRef.current?.click()}
                type="button"
              >
                {organization.logoAttachmentId ? 'Replace logo' : 'Upload logo'}
              </button>
              {organization.logoAttachmentId && (
                <button
                  className="admin-button admin-button-secondary"
                  disabled={busy}
                  onClick={handleRemove}
                  type="button"
                >
                  Remove
                </button>
              )}
            </div>
            <div className="text-xs text-[color:var(--tx3)]">PNG or JPG. Square images work best.</div>
            <input
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
              ref={inputRef}
              type="file"
            />
          </div>
        ) : (
          <div className="text-sm text-[color:var(--tx3)]">
            Only organisation owners and admins can change the logo.
          </div>
        )}
      </div>

      {error && <div className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</div>}

      {selectedFile && (
        <CircleImageCropper
          busy={busy}
          description="Drag to reposition, scroll or use the slider to zoom. The circle is what becomes your logo."
          file={selectedFile}
          onCancel={() => setSelectedFile(null)}
          onSave={handleSave}
          saveLabel="Save logo"
          title="Edit logo"
        />
      )}
    </section>
  )
}
