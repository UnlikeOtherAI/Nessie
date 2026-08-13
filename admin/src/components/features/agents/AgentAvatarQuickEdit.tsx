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

type AgentAvatarQuickEditProps = {
  agent: AgentRecord
  canEdit: boolean
}

const PencilIcon = () => (
  <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" width="14">
    <path d="M12 20h9" strokeLinecap="round" />
    <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const SparkleIcon = () => (
  <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
    <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7L19 15z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const UploadIcon = () => (
  <svg aria-hidden="true" fill="none" height="20" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24" width="20">
    <path d="M12 16V4m0 0L8 8m4-4l4 4M5 14v5h14v-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const isImageFile = (file: File): boolean => file.type.startsWith('image/')

export const AgentAvatarQuickEdit = ({ agent, canEdit }: AgentAvatarQuickEditProps) => {
  const { token } = useAuthSession()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const sourceDialogRef = useRef<HTMLDivElement | null>(null)
  const replacementDialogRef = useRef<HTMLDivElement | null>(null)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [generatedAvatar, setGeneratedAvatar] = useState<GeneratedAgentAvatar | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const avatarChanges = useAgentAvatarChanges(agent.id, {
    name: agent.name,
    role: agent.role,
    systemPrompt: agent.systemPrompt ?? '',
  })

  const closeSource = useCallback(() => setSourceOpen(false), [])
  const closeReplacement = useCallback(() => setGeneratedAvatar(null), [])
  useModalA11y(sourceDialogRef, closeSource, sourceOpen)
  useModalA11y(replacementDialogRef, closeReplacement, Boolean(generatedAvatar))

  const selectFile = (file?: File) => {
    setFileError(null)
    avatarChanges.clearError()
    if (!file) return
    if (!isImageFile(file)) {
      setFileError('Choose an image file to use as this avatar.')
      return
    }
    setSourceOpen(false)
    setSelectedFile(file)
  }

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    selectFile(event.dataTransfer.files[0])
  }

  const handleGenerate = async () => {
    setFileError(null)
    const preview = await avatarChanges.generate()
    if (!preview) return
    setSourceOpen(false)
    setGeneratedAvatar(preview)
  }

  const handleSaveUpload = async (blob: Blob) => {
    await avatarChanges.upload(blob)
    setSelectedFile(null)
  }

  const confirmGeneratedAvatar = async () => {
    if (!generatedAvatar) return
    if (await avatarChanges.replace(generatedAvatar)) closeReplacement()
  }

  const error = fileError ?? avatarChanges.error

  return (
    <>
      <div className="relative inline-flex">
        <AgentAvatar agent={agent} size="lg" token={token} />
        {canEdit ? (
          <button
            aria-label={`Edit ${agent.name} avatar`}
            className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full border-2 border-[color:var(--sb)] bg-[color:var(--accent)] text-[color:var(--on-accent)] shadow-sm transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-[color:var(--accent)] focus:ring-offset-2 focus:ring-offset-[color:var(--main)]"
            onClick={() => {
              setFileError(null)
              avatarChanges.clearError()
              setSourceOpen(true)
            }}
            title="Change avatar"
            type="button"
          >
            <PencilIcon />
          </button>
        ) : null}
      </div>

      {sourceOpen ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSource()
          }}
          role="presentation"
        >
          <div
            aria-describedby="agent-avatar-source-description"
            aria-labelledby="agent-avatar-source-title"
            aria-modal="true"
            className="w-full max-w-lg rounded-xl border border-[var(--sep)] bg-[var(--panel)] p-5 shadow-2xl"
            ref={sourceDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[color:var(--tx)]" id="agent-avatar-source-title">
                  Update avatar
                </h2>
                <p className="mt-1 text-sm text-[color:var(--tx2)]" id="agent-avatar-source-description">
                  Generate a new cartoon headshot or upload an image you already have.
                </p>
              </div>
              <button className="admin-button admin-button-secondary" onClick={closeSource} type="button">
                Cancel
              </button>
            </div>

            <button
              className="mt-5 flex w-full items-center gap-3 rounded-xl border border-[color:var(--sep)] bg-[color:var(--overlay-weak)] p-4 text-left transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] disabled:cursor-wait disabled:opacity-70"
              disabled={avatarChanges.busy}
              onClick={() => void handleGenerate()}
              type="button"
            >
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-[color:var(--accent-soft)] text-[color:var(--accent)]">
                {avatarChanges.isGenerating ? (
                  <AgentAvatarGenerationIndicator iconOnly />
                ) : <SparkleIcon />}
              </span>
              <span>
                <span className="block font-medium text-[color:var(--tx)]">
                  {avatarChanges.isGenerating ? 'Generating headshot…' : 'Generate with AI'}
                </span>
                <span className="mt-0.5 block text-sm text-[color:var(--tx2)]">
                  Creates an original cartoon headshot from this agent’s role and purpose.
                </span>
              </span>
            </button>

            <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-[0.16em] text-[color:var(--tx3)]">
              <span className="h-px flex-1 bg-[color:var(--sep)]" />
              or
              <span className="h-px flex-1 bg-[color:var(--sep)]" />
            </div>

            <button
              aria-label="Upload avatar"
              className="flex min-h-36 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-[color:var(--sep)] px-5 py-6 text-center text-[color:var(--tx2)] transition hover:border-[color:var(--accent)] hover:bg-[color:var(--accent-soft)] focus:border-[color:var(--accent)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              disabled={avatarChanges.busy}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              type="button"
            >
              <span className="grid h-10 w-10 place-items-center rounded-lg bg-[color:var(--overlay)] text-[color:var(--accent)]"><UploadIcon /></span>
              <span className="mt-3 font-medium text-[color:var(--tx)]">Drop an image here</span>
              <span className="mt-1 text-sm">or click to choose a file · PNG, JPG, or WebP</span>
            </button>
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
            {avatarChanges.isGenerating ? (
              <AgentAvatarGenerationIndicator className="mt-4" />
            ) : null}
            {error ? <p className="mt-3 text-sm text-[color:var(--danger-text)]">{error}</p> : null}
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

      {generatedAvatar ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeReplacement()
          }}
          role="presentation"
        >
          <div
            aria-describedby="agent-avatar-replacement-description"
            aria-labelledby="agent-avatar-replacement-title"
            aria-modal="true"
            className="w-full max-w-md rounded-xl border border-[var(--sep)] bg-[var(--panel)] p-5 shadow-2xl"
            ref={replacementDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <h2 className="text-base font-semibold text-[color:var(--tx)]" id="agent-avatar-replacement-title">
              Replace this agent’s avatar?
            </h2>
            <p className="mt-1 text-sm text-[color:var(--tx2)]" id="agent-avatar-replacement-description">
              Review the newly generated headshot before replacing the current avatar.
            </p>
            <div className="mt-5 flex items-center justify-center gap-8">
              <div className="grid justify-items-center gap-2 text-xs text-[color:var(--tx3)]">
                <AgentAvatar agent={agent} size="xl" token={token} />
                Current
              </div>
              <div className="grid justify-items-center gap-2 text-xs text-[color:var(--tx3)]">
                <AgentAvatar agent={{ ...agent, ...generatedAvatar }} size="xl" token={token} />
                New
              </div>
            </div>
            {error ? <p className="mt-4 text-sm text-[color:var(--danger-text)]">{error}</p> : null}
            <div className="mt-6 flex justify-end gap-2">
              <button className="admin-button admin-button-secondary" disabled={avatarChanges.isReplacing} onClick={closeReplacement} type="button">
                Keep current
              </button>
              <button className="admin-button admin-button-primary" disabled={avatarChanges.isReplacing} onClick={() => void confirmGeneratedAvatar()} type="button">
                {avatarChanges.isReplacing ? 'Replacing…' : 'Use new headshot'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
