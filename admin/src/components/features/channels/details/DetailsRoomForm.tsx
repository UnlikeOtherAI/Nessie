import { toChannelNameInput, toChannelSlug } from '@nessie/schemas'
import { useEffect, useState, type FormEvent } from 'react'
import { useUpdateChannel } from '../../../../facades/channels/hooks'
import type { ChannelRecord } from '../../../../lib/api-client'
import { ChoiceGroup } from '../../../shared/ChoiceGroup'
import { FormActions, FormSuccess } from '../../../shared/FormActions'
import { Input, Textarea } from '../../../shared/FormControls'
import { FormField } from '../../../shared/FormField'

type RoomVisibility = 'public' | 'protected'

const VISIBILITY_COPY: Record<RoomVisibility, { consequence: string; description: string; label: string }> = {
  protected: {
    consequence:
      'Once saved, people outside this channel can no longer find it, and any computer access a ticket automation holds here ends.',
    description: 'Only the people in it can read it. Everyone else has to be added.',
    label: 'Protected',
  },
  public: {
    consequence: 'Once saved, everyone in the organisation can find this channel and join it.',
    description: 'Everyone in the organisation can find it and join.',
    label: 'Public',
  },
}

type Metadata = { description: string; label: string; topic: string; visibility: RoomVisibility }

const metadataOf = (channel: ChannelRecord): Metadata => ({
  description: channel.description ?? '',
  label: channel.label,
  topic: channel.topic ?? '',
  visibility: channel.visibility === 'protected' ? 'protected' : 'public',
})

/**
 * A room's name, topic, description and visibility. Only what the person
 * changed is sent, measured against what they started from rather than the
 * live record: a refresh that lands while they type (somebody else's topic
 * edit) is never overwritten by a field they did not touch, and the decision
 * policy — its own section — is never part of this save.
 *
 * A refused save (a name already taken here) is said on the Name field, as
 * the settings dialog this replaced did.
 *
 * Changing visibility says what it does before it is saved: making a room
 * protected ends any standing computer access a ticket trigger's work holds
 * in it (docs/standards/ticket-work-machine-access.md).
 */
export const DetailsRoomForm = ({ canManage, channel }: { canManage: boolean; channel: ChannelRecord }) => {
  const updateChannel = useUpdateChannel()
  const [initial, setInitial] = useState<Metadata>(() => metadataOf(channel))
  const [draft, setDraft] = useState<Metadata>(initial)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!saved) return
    const id = window.setTimeout(() => setSaved(false), 2500)
    return () => window.clearTimeout(id)
  }, [saved])

  const nextLabel = toChannelSlug(draft.label)
  const changes = {
    ...(nextLabel !== initial.label ? { label: nextLabel } : {}),
    ...(draft.topic !== initial.topic ? { topic: draft.topic.trim() || null } : {}),
    ...(draft.description !== initial.description ? { description: draft.description.trim() || null } : {}),
    ...(draft.visibility !== initial.visibility ? { visibility: draft.visibility } : {}),
  }
  const changed = Object.keys(changes).length > 0
  const disabled = !canManage || updateChannel.isPending

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage || !nextLabel || !changed) return
    setError(null)
    try {
      await updateChannel.mutateAsync({ channelId: channel.id, ...changes })
      const next = { ...draft, label: nextLabel }
      setInitial(next)
      setDraft(next)
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The channel could not be saved.')
    }
  }

  return (
    <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
      <FormField
        error={error ?? undefined}
        help="Lowercase letters, numbers and hyphens. Spaces become hyphens."
        label="Name"
        required
      >
        <Input
          autoComplete="off"
          disabled={disabled}
          onBlur={() => setDraft((current) => ({ ...current, label: toChannelSlug(current.label) }))}
          onChange={(event) => {
            setDraft((current) => ({ ...current, label: toChannelNameInput(event.target.value) }))
            setError(null)
          }}
          value={draft.label}
        />
      </FormField>
      <FormField label="Topic">
        <Input
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => setDraft((current) => ({ ...current, topic: event.target.value }))}
          placeholder="What is this channel about?"
          value={draft.topic}
        />
      </FormField>
      <FormField label="Description">
        <Textarea
          disabled={disabled}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          placeholder="Longer description (optional)"
          rows={3}
          value={draft.description}
        />
      </FormField>
      <ChoiceGroup<RoomVisibility>
        label="Who can see it"
        onChange={(visibility) => setDraft((current) => ({ ...current, visibility }))}
        options={(['public', 'protected'] as const).map((value) => ({
          description: VISIBILITY_COPY[value].description,
          disabled,
          label: VISIBILITY_COPY[value].label,
          value,
        }))}
        value={draft.visibility}
        variant="card"
      />
      {draft.visibility !== initial.visibility ? (
        <p className="text-sm text-[color:var(--tx2)]" role="status">
          {VISIBILITY_COPY[draft.visibility].consequence}
        </p>
      ) : null}
      <FormSuccess>{saved ? 'Saved.' : undefined}</FormSuccess>
      <FormActions>
        <button
          className="admin-button admin-button-primary"
          disabled={!canManage || !nextLabel || !changed || updateChannel.isPending}
          type="submit"
        >
          {updateChannel.isPending ? 'Saving…' : 'Save'}
        </button>
      </FormActions>
    </form>
  )
}
