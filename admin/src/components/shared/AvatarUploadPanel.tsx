import { useRef, useState, type ReactNode } from 'react'
import { SectionLabel } from '../primitives/SectionLabel'
import { CircleImageCropper } from './CircleImageCropper'

type AvatarUploadPanelProps = {
  busy: boolean
  cropperDescription: string
  cropperTitle: string
  error: string | null
  hasCustom: boolean
  helperText?: string
  hint: string
  onRemove: () => void
  onSave: (blob: Blob) => Promise<void>
  preview: ReactNode
  removeLabel?: string
  replaceLabel?: string
  saveLabel: string
  title: string
  uploadLabel?: string
}

export const AvatarUploadPanel = ({
  busy,
  cropperDescription,
  cropperTitle,
  error,
  hasCustom,
  helperText = 'PNG or JPG. Square images work best.',
  hint,
  onRemove,
  onSave,
  preview,
  removeLabel = 'Remove',
  replaceLabel = 'Replace photo',
  saveLabel,
  title,
  uploadLabel = 'Upload photo',
}: AvatarUploadPanelProps) => {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setSelectedFile(file)
  }

  const handleSave = async (blob: Blob) => {
    await onSave(blob)
    setSelectedFile(null)
  }

  return (
    <section className="admin-card p-4">
      <SectionLabel>{title}</SectionLabel>
      <div className="mt-2 text-sm text-[color:var(--tx2)]">{hint}</div>

      <div className="mt-4 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
        {preview}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <button
              className="admin-button admin-button-primary"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {hasCustom ? replaceLabel : uploadLabel}
            </button>
            {hasCustom ? (
              <button
                className="admin-button admin-button-secondary"
                disabled={busy}
                onClick={onRemove}
                type="button"
              >
                {removeLabel}
              </button>
            ) : null}
          </div>
          <div className="text-xs text-[color:var(--tx3)]">{helperText}</div>
          <input
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
            ref={inputRef}
            type="file"
          />
        </div>
      </div>

      {error ? <div className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</div> : null}

      {selectedFile ? (
        <CircleImageCropper
          busy={busy}
          description={cropperDescription}
          file={selectedFile}
          onCancel={() => setSelectedFile(null)}
          onSave={handleSave}
          saveLabel={saveLabel}
          shape="rounded"
          title={cropperTitle}
        />
      ) : null}
    </section>
  )
}
