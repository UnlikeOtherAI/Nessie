import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { CircleImageCropper } from '../../shared/CircleImageCropper'
import { useModalA11y } from '../../shared/useModalA11y'
import {
  type GeneratedAgentAvatar,
  useAgentAvatarChanges,
} from './useAgentAvatarChanges'
import { AgentAvatarGenerationIndicator } from './AgentAvatarGenerationIndicator'

type AgentAvatarContext = {
  name: string
  role: string
  systemPrompt: string
}

type AgentAvatarQuickEditProps = {
  agent: AgentRecord
  // Draft name/role/prompt from an open editor, so a generated headshot reflects
  // edits not yet saved. Defaults to the agent's stored values.
  avatarContext?: AgentAvatarContext
  canEdit: boolean
  // Trigger avatar size; the modal always shows a larger preview.
  size?: 'lg' | 'xl'
}

const PencilIcon = () => (
  <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="14">
    <path d="M12 20h9" strokeLinecap="round" />
    <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const SparkleIcon = () => (
  <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const UploadIcon = () => (
  <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="16">
    <path d="M12 16V4m0 0L8 8m4-4l4 4M5 14v5h14v-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CloseIcon = () => (
  <svg aria-hidden="true" fill="none" height="16" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="16">
    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
  </svg>
)

const isImageFile = (file: File): boolean => file.type.startsWith('image/')

export const AgentAvatarQuickEdit = ({
  agent,
  avatarContext,
  canEdit,
  size = 'lg',
}: AgentAvatarQuickEditProps) => {
  const { token } = useAuthSession()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [generated, setGenerated] = useState<GeneratedAgentAvatar | null>(null)
  const [prompt, setPrompt] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const avatarChanges = useAgentAvatarChanges(
    agent.id,
    avatarContext ?? {
      name: agent.name,
      role: agent.role,
      systemPrompt: agent.systemPrompt ?? '',
    },
  )

  const hasCustom = Boolean(agent.avatarAttachmentId)
  const close = useCallback(() => {
    setOpen(false)
    setGenerated(null)
    setPrompt('')
    setFileError(null)
  }, [])
  useModalA11y(dialogRef, close, open)

  const selectFile = (file?: File) => {
    setFileError(null)
    avatarChanges.clearError()
    if (!file) return
    if (!isImageFile(file)) {
      setFileError('Choose an image file to use as this avatar.')
      return
    }
    setSelectedFile(file)
  }

  const handleGenerate = async () => {
    setFileError(null)
    const preview = await avatarChanges.generate(prompt)
    if (preview) setGenerated(preview)
  }

  const useGenerated = async () => {
    if (!generated) return
    if (await avatarChanges.replace(generated)) close()
  }

  const handleRemove = async () => {
    await avatarChanges.remove()
    close()
  }

  const handleSaveUpload = async (blob: Blob) => {
    await avatarChanges.upload(blob)
    setSelectedFile(null)
    close()
  }

  const previewAgent = generated ? { ...agent, ...generated } : agent
  const error = fileError ?? avatarChanges.error

  return (
    <>
      <div className="relative inline-flex">
        <AgentAvatar agent={agent} size={size} token={token} />
        {canEdit ? (
          <button
            aria-label={`Edit ${agent.name} avatar`}
            className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border-2 border-[color:var(--sb)] bg-[color:var(--accent)] text-[color:var(--on-accent)] shadow-sm transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] focus:ring-offset-2 focus:ring-offset-[color:var(--main)]"
            onClick={() => {
              setFileError(null)
              avatarChanges.clearError()
              setOpen(true)
            }}
            title="Change avatar"
            type="button"
          >
            <PencilIcon />
          </button>
        ) : null}
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close()
          }}
          role="presentation"
        >
          <div
            aria-label={`${agent.name} avatar`}
            aria-modal="true"
            className="relative w-full max-w-sm rounded-2xl border border-[var(--sep)] bg-[var(--panel)] p-6 shadow-2xl"
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <button
              aria-label="Close"
              className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-[color:var(--tx3)] transition hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]"
              onClick={close}
              type="button"
            >
              <CloseIcon />
            </button>

            <div className="flex flex-col items-center gap-4 pt-2">
              <div className="rounded-2xl ring-1 ring-[color:var(--sep)]">
                <AgentAvatar agent={previewAgent} size="xl" token={token} />
              </div>

              {avatarChanges.isGenerating ? (
                <AgentAvatarGenerationIndicator />
              ) : null}

              {generated ? (
                <div className="flex w-full gap-2">
                  <button
                    className="admin-button admin-button-secondary flex-1"
                    disabled={avatarChanges.busy}
                    onClick={() => setGenerated(null)}
                    type="button"
                  >
                    Discard
                  </button>
                  <button
                    className="admin-button admin-button-primary flex-1"
                    disabled={avatarChanges.isReplacing}
                    onClick={() => void useGenerated()}
                    type="button"
                  >
                    {avatarChanges.isReplacing ? 'Saving…' : 'Use this'}
                  </button>
                </div>
              ) : (
                <div className="w-full space-y-3">
                  <input
                    aria-label="Describe the avatar"
                    className="admin-input w-full"
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !avatarChanges.busy) {
                        event.preventDefault()
                        void handleGenerate()
                      }
                    }}
                    placeholder="Add avatar details to the agent instructions (optional)"
                    type="text"
                    value={prompt}
                  />
                  <div className="flex gap-2">
                    <button
                      className="admin-button admin-button-primary flex-1 gap-1.5"
                      disabled={avatarChanges.busy}
                      onClick={() => void handleGenerate()}
                      type="button"
                    >
                      <SparkleIcon />
                      {avatarChanges.isGenerating ? 'Generating…' : 'Generate with AI'}
                    </button>
                    <button
                      aria-label="Upload image"
                      className="admin-button admin-button-secondary gap-1.5"
                      disabled={avatarChanges.busy}
                      onClick={() => fileInputRef.current?.click()}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event: DragEvent<HTMLButtonElement>) => {
                        event.preventDefault()
                        selectFile(event.dataTransfer.files[0])
                      }}
                      type="button"
                    >
                      <UploadIcon />
                      Upload
                    </button>
                  </div>
                </div>
              )}

              {error ? (
                <p className="text-sm text-[color:var(--danger-text)]">{error}</p>
              ) : null}
            </div>

            {hasCustom && !generated ? (
              <div className="mt-5 flex justify-end border-t border-[color:var(--sep)] pt-3">
                <button
                  className="text-sm font-medium text-[color:var(--danger-text)] transition hover:underline disabled:opacity-60"
                  disabled={avatarChanges.busy}
                  onClick={() => void handleRemove()}
                  type="button"
                >
                  Remove image
                </button>
              </div>
            ) : null}

            <input
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                selectFile(event.target.files?.[0])
                event.target.value = ''
              }}
              ref={fileInputRef}
              type="file"
            />
          </div>
        </div>
      ) : null}

      {selectedFile ? (
        <CircleImageCropper
          busy={avatarChanges.busy}
          description="Drag to reposition, scroll or use the slider to zoom. The rounded square becomes this agent avatar."
          file={selectedFile}
          onCancel={() => setSelectedFile(null)}
          onSave={handleSaveUpload}
          saveLabel="Save avatar"
          shape="rounded"
          title="Edit agent avatar"
        />
      ) : null}
    </>
  )
}
