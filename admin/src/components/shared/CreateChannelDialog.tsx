import { toChannelNameInput, toChannelSlug } from '@nessie/schemas'
import { useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useCreateChannel } from '../../facades/channels/hooks'
import type { ChannelRecord } from '../../lib/api-client'
import { Dialog } from './Dialog'
import { fieldErrorAria, fieldErrorProps } from './FormFieldError'

type CreateChannelDialogProps = {
  onClose: () => void
  // Fires with the new channel before the navigation to it, so a sidebar
  // section that is closed can open in the same paint the row appears in.
  onCreated?: (channel: ChannelRecord) => void
  open: boolean
  projectName?: string
  projectId?: string
  scope?: 'standalone'
  teamId?: string
}

export const CreateChannelDialog = (
  { onClose, onCreated, open, projectId, projectName, scope, teamId }: CreateChannelDialogProps,
) => {
  const { t } = useTranslation('channels')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const createChannel = useCreateChannel()
  const projectTeamIsMissing = projectId !== undefined && scope !== 'standalone' && !teamId

  const [name, setName] = useState('')
  // `private` is not a choice a person makes. It is the stored value for direct
  // messages and system surfaces, which this dialog never creates; somebody who
  // wants "not everyone" means `protected`, which has a member list and a lock.
  const [visibility, setVisibility] = useState<'protected' | 'public'>('public')
  const [formError, setFormError] = useState<string | null>(null)

  const handleClose = () => {
    setName('')
    setVisibility('public')
    setFormError(null)
    onClose()
  }

  const handleSubmit = async (
    event: FormEvent<HTMLFormElement>,
  ) => {
    event.preventDefault()
    const label = toChannelSlug(name)
    if (!label || projectTeamIsMissing) return

    try {
      const created = await createChannel.mutateAsync({
        label,
        projectId,
        scope,
        teamId,
        visibility,
      })
      onCreated?.(created)
      handleClose()
      void navigate(`/channels/${created.id}`)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t('createChannel.error'))
    }
  }

  return (
    <Dialog
      description={projectName ? t('createChannel.inProject', { name: projectName }) : undefined}
      initialFocusRef={nameInputRef}
      onClose={handleClose}
      open={open}
      title={t('createChannel.title')}
    >
      <form className="grid gap-4" onSubmit={handleSubmit}>
        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="channel-name"
          >
            {t('createChannel.name')}
          </label>
          <input
            ref={nameInputRef}
            {...fieldErrorAria('channel-name', formError)}
            autoComplete="off"
            className="admin-input"
            id="channel-name"
            onChange={(e) => {
              setName(toChannelNameInput(e.target.value))
              setFormError(null)
            }}
            onBlur={() => setName(toChannelSlug(name))}
            placeholder={t('createChannel.placeholder')}
            value={name}
          />
          <div className="text-xs text-[color:var(--tx3)]">
            {t('createChannel.nameHelp')}
          </div>
          {/*
            The bare red line is the shipped treatment and stays: only the
            announcement contract (id + role="alert", paired with the input's
            aria above) is new. `formError` is written in the submit catch and
            cleared on the next keystroke, so it announces once per rejection.
          */}
          {formError ? (
            <div
              className="text-xs text-[color:var(--danger-text)]"
              {...fieldErrorProps('channel-name')}
            >
              {formError}
            </div>
          ) : null}
        </div>

        <div className="grid gap-1.5">
          <label
            className={[
              'text-xs font-semibold uppercase',
              'tracking-[0.16em] text-[color:var(--tx3)]',
            ].join(' ')}
            htmlFor="channel-visibility"
          >
            {t('createChannel.visibility')}
          </label>
          <select
            className="admin-input"
            id="channel-visibility"
            onChange={(e) => setVisibility(
              e.target.value as typeof visibility,
            )}
            value={visibility}
          >
            <option value="public">{t('createChannel.public')}</option>
            <option value="protected">{t('createChannel.protected')}</option>
          </select>
          <p className="text-xs text-[color:var(--tx3)]">
            {visibility === 'public'
              ? t('createChannel.publicHelp')
              : t('createChannel.protectedHelp')}
          </p>
        </div>

        {projectTeamIsMissing ? (
          <p className="text-xs text-[color:var(--tx3)]" role="status">
            {t('createChannel.missingTeam')}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            className="admin-button admin-button-secondary"
            onClick={handleClose}
            type="button"
          >
            {t('createChannel.cancel')}
          </button>
          <button
            className="admin-button admin-button-primary"
            disabled={!toChannelSlug(name) || projectTeamIsMissing}
            type="submit"
          >
            {t('createChannel.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
