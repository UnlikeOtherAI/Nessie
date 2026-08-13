import { useCallback, useRef, useState } from 'react'
import type { AgentRecord } from '../../../lib/api-client'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { AgentAvatar } from '../../shared/AgentAvatar'
import { AvatarUploadPanel } from '../../shared/AvatarUploadPanel'
import { useModalA11y } from '../../shared/useModalA11y'
import {
  type GeneratedAgentAvatar,
  useAgentAvatarChanges,
} from './useAgentAvatarChanges'

type AgentAvatarPanelProps = {
  agent: AgentRecord
  avatarContext?: {
    name: string
    role: string
    systemPrompt: string
  }
}

const sourceHint = (hasCustom: boolean): string =>
  hasCustom
    ? "Using this agent's current avatar. Replace it with an upload or generate a new headshot."
    : 'Upload an avatar or generate a cartoon headshot based on this agent’s role.'

export const AgentAvatarPanel = ({ agent, avatarContext }: AgentAvatarPanelProps) => {
  const { token } = useAuthSession()
  const [generatedAvatar, setGeneratedAvatar] = useState<GeneratedAgentAvatar | null>(null)
  const replacementDialogRef = useRef<HTMLDivElement | null>(null)
  const hasCustom = Boolean(agent.avatarAttachmentId)
  const avatarChanges = useAgentAvatarChanges(agent.id, avatarContext)

  const closeGeneratedAvatar = useCallback(() => setGeneratedAvatar(null), [])
  useModalA11y(replacementDialogRef, closeGeneratedAvatar)

  const handleGenerate = async () => {
    const preview = await avatarChanges.generate()
    if (preview) setGeneratedAvatar(preview)
  }

  const confirmGeneratedAvatar = async () => {
    if (!generatedAvatar) return
    if (await avatarChanges.replace(generatedAvatar)) closeGeneratedAvatar()
  }

  return (
    <>
      <AvatarUploadPanel
        busy={avatarChanges.busy}
        cropperDescription="Drag to reposition, scroll or use the slider to zoom. The rounded square becomes this agent avatar."
        cropperTitle="Edit agent avatar"
        error={avatarChanges.error}
        hasCustom={hasCustom}
        hint={sourceHint(hasCustom)}
        preview={
          <AgentAvatar
            agent={agent}
            className="border border-[color:var(--sep)]"
            size="xl"
            token={token}
          />
        }
        replaceLabel="Replace avatar"
        saveLabel="Save avatar"
        title="Agent avatar"
        uploadLabel="Upload avatar"
        onRemove={() => void avatarChanges.remove()}
        onSave={avatarChanges.upload}
      />
      <section className="admin-card p-4">
        <div className="text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]">
          AI headshot
        </div>
        <p className="mt-2 text-sm text-[color:var(--tx2)]">
          Create a cartoon-style headshot from this agent’s name, role, and
          purpose. The image uses a random flat pastel background.
        </p>
        <button
          className="admin-button admin-button-secondary mt-4"
          disabled={avatarChanges.busy}
          onClick={() => void handleGenerate()}
          type="button"
        >
          {avatarChanges.isGenerating ? 'Generating headshot…' : 'Generate new headshot'}
        </button>
      </section>
      {generatedAvatar ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim-strong)] p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeGeneratedAvatar()
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
                <AgentAvatar
                  agent={{ ...agent, ...generatedAvatar }}
                  size="xl"
                  token={token}
                />
                New
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                className="admin-button admin-button-secondary"
              disabled={avatarChanges.isReplacing}
                onClick={closeGeneratedAvatar}
                type="button"
              >
                Keep current
              </button>
              <button
                className="admin-button admin-button-primary"
              disabled={avatarChanges.isReplacing}
                onClick={() => void confirmGeneratedAvatar()}
                type="button"
              >
                {avatarChanges.isReplacing ? 'Replacing…' : 'Use new headshot'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
