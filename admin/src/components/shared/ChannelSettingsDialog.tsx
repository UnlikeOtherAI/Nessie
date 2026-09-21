import {
  ChannelDecisionPolicySchema,
  DEFAULT_CHANNEL_DECISION_POLICY,
  toChannelNameInput,
  toChannelSlug,
  type ChannelDecisionPolicy,
} from '@nessie/schemas'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { AgentRecord, ChannelRecord } from '../../lib/api-client'
import {
  useArchiveChannel,
  useUpdateChannel,
} from '../../facades/channels/hooks'
import { ConfirmDialog } from './ConfirmDialog'
import { Dialog } from './Dialog'
import { fieldErrorAria, fieldErrorProps } from './FormFieldError'
import { TabBar } from '../primitives/TabBar'
import { ChannelDecisionPolicyEditor } from './ChannelDecisionPolicyEditor'

type ChannelSettingsDialogProps = {
  boundAgents?: AgentRecord[]
  channel: ChannelRecord
  onClose: () => void
  open: boolean
}

export const ChannelSettingsDialog = (
  { boundAgents = [], channel, onClose, open }: ChannelSettingsDialogProps,
) => {
  const navigate = useNavigate()
  const updateChannel = useUpdateChannel()
  const archiveChannel = useArchiveChannel()

  const [label, setLabel] = useState(channel.label)
  const [topic, setTopic] = useState(channel.topic ?? '')
  const [description, setDescription] = useState(channel.description ?? '')
  const [initialMetadata, setInitialMetadata] = useState({
    label: channel.label, topic: channel.topic ?? '', description: channel.description ?? '',
  })
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [tab, setTab] = useState<'channel' | 'decisions'>('channel')
  const [policy, setPolicy] = useState<ChannelDecisionPolicy>(
    channel.decisionPolicy ?? DEFAULT_CHANNEL_DECISION_POLICY,
  )
  const [policyErrors, setPolicyErrors] = useState<Record<string, string>>({})
  const [savedPolicy, setSavedPolicy] = useState(JSON.stringify(policy))
  const initializedChannel = useRef<string | null>(null)
  const policyChanged = JSON.stringify(policy) !== savedPolicy
  const policyConflict = policyChanged
    && JSON.stringify(channel.decisionPolicy ?? DEFAULT_CHANNEL_DECISION_POLICY) !== savedPolicy

  const isArchived = Boolean(channel.archivedAt)

  useEffect(() => {
    if (!open) initializedChannel.current = null
    if (open && initializedChannel.current !== channel.id) {
      initializedChannel.current = channel.id
      setLabel(channel.label)
      setTopic(channel.topic ?? '')
      setDescription(channel.description ?? '')
      setInitialMetadata({ label: channel.label, topic: channel.topic ?? '', description: channel.description ?? '' })
      setConfirmDelete(false)
      setConfirmArchive(false)
      setFormError(null)
      setTab('channel')
      const initialPolicy = channel.decisionPolicy ?? DEFAULT_CHANNEL_DECISION_POLICY
      setPolicy(initialPolicy)
      setSavedPolicy(JSON.stringify(initialPolicy))
      setPolicyErrors({})
    }
  }, [open, channel])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextLabel = toChannelSlug(label)
    if (!nextLabel) return
    if (policyConflict) {
      setTab('decisions')
      return
    }
    const parsed = ChannelDecisionPolicySchema.safeParse(policy)
    if (policyChanged && !parsed.success) {
      setPolicyErrors(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message])))
      setTab('decisions')
      return
    }

    try {
      await updateChannel.mutateAsync({
        channelId: channel.id,
        ...(nextLabel !== initialMetadata.label ? { label: nextLabel } : {}),
        ...(topic !== initialMetadata.topic ? { topic: topic.trim() || null } : {}),
        ...(description !== initialMetadata.description ? { description: description.trim() || null } : {}),
        ...(policyChanged && parsed.success ? { decisionPolicy: parsed.data } : {}),
      })
      onClose()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save channel.')
    }
  }

  const handleArchiveToggle = async () => {
    // Unarchiving can be refused: an archived channel does not hold its name,
    // so somebody may have taken it while this one was away. The refusal says
    // which channel to rename, and it belongs on the form rather than in a
    // rejected promise nobody sees.
    try {
      await archiveChannel.mutateAsync({
        archived: !isArchived,
        channelId: channel.id,
      })
    } catch (error) {
      setConfirmArchive(false)
      setFormError(
        error instanceof Error ? error.message : 'Unable to change the channel archive state.',
      )
      return
    }
    setConfirmArchive(false)
    onClose()
  }

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await archiveChannel.mutateAsync({ archived: true, channelId: channel.id })
    onClose()
    void navigate('/channels')
  }

  // Rendered only for somebody the server lets change this channel. The header
  // gear is gated the same way; this is the second lock, so a stale open state
  // or a future doorway cannot show edit controls that would only be refused.
  if (!channel.viewerCanManage) return null

  return (
    <>
      <Dialog description={`#${channel.label}`} onClose={onClose} open={open} size="lg" title="Channel settings">
        <form className="grid min-w-0 gap-4" noValidate onSubmit={handleSubmit}>
          <TabBar
            ariaLabel="Channel settings sections"
            idPrefix="channel-settings"
            items={[{ label: 'Channel', value: 'channel' }, { label: 'Agent decisions', value: 'decisions' }]}
            onChange={setTab}
            value={tab}
          />
          <div
            aria-labelledby="channel-settings-tab-channel"
            className="grid gap-4"
            hidden={tab !== 'channel'}
            id="channel-settings-tabpanel-channel"
            role="tabpanel"
          >
            <div className="grid gap-1.5">
              <label
                className={[
                  'text-xs font-semibold uppercase',
                  'tracking-[0.16em] text-[color:var(--tx3)]',
                ].join(' ')}
                htmlFor="channel-settings-name"
              >
                Name
              </label>
              <input
                {...fieldErrorAria('channel-settings-name', formError)}
                autoComplete="off"
                className="admin-input"
                id="channel-settings-name"
                onChange={(e) => {
                  setLabel(toChannelNameInput(e.target.value))
                  setFormError(null)
                }}
                onBlur={() => setLabel(toChannelSlug(label))}
                value={label}
              />
              <div className="text-xs text-[color:var(--tx3)]">
                Lowercase letters, numbers and hyphens. Spaces become hyphens.
              </div>
              {/*
                Same shape as CreateChannelDialog: the red line is unchanged, and
                only the id + role="alert" pairing it to the input above is new.
                Written in the save catch, cleared on the next keystroke.
              */}
              {formError ? (
                <div
                  className="text-xs text-[color:var(--danger-text)]"
                  {...fieldErrorProps('channel-settings-name')}
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
                htmlFor="channel-settings-topic"
              >
                Topic
              </label>
              <input
                autoComplete="off"
                className="admin-input"
                id="channel-settings-topic"
                onChange={(e) => setTopic(e.target.value)}
                placeholder="What is this channel about?"
                value={topic}
              />
            </div>

            <div className="grid gap-1.5">
              <label
                className={[
                  'text-xs font-semibold uppercase',
                  'tracking-[0.16em] text-[color:var(--tx3)]',
                ].join(' ')}
                htmlFor="channel-settings-description"
              >
                Description
              </label>
              <textarea
                className="admin-input"
                id="channel-settings-description"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Longer description (optional)"
                rows={3}
                value={description}
              />
            </div>
          </div>
          <div
            aria-labelledby="channel-settings-tab-decisions"
            hidden={tab !== 'decisions'}
            id="channel-settings-tabpanel-decisions"
            role="tabpanel"
          >
            {policyConflict ? (
              <div className="mb-4 grid gap-2 text-sm" role="alert">
                <p>These decisions changed while you were editing. Load the latest version before saving.</p>
                <button
                  className="admin-button admin-button-secondary justify-self-start"
                  onClick={() => {
                    const latest = channel.decisionPolicy ?? DEFAULT_CHANNEL_DECISION_POLICY
                    setPolicy(latest)
                    setSavedPolicy(JSON.stringify(latest))
                    setPolicyErrors({})
                  }}
                  type="button"
                >
                  Load latest decisions
                </button>
              </div>
            ) : null}
            <ChannelDecisionPolicyEditor
              agents={boundAgents}
              errors={policyErrors}
              onChange={(next) => { setPolicy(next); setPolicyErrors({}); setFormError(null) }}
              policy={policy}
            />
          </div>
          {formError && tab === 'decisions' ? (
            <p className="text-xs text-[color:var(--danger-text)]" role="alert">{formError}</p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--bd)] pt-3">
            <div className="flex gap-2" hidden={tab !== 'channel'}>
              <button
                className="admin-button admin-button-secondary"
                disabled={archiveChannel.isPending}
                onClick={() => {
                  if (isArchived) {
                    void handleArchiveToggle()
                  } else {
                    setConfirmArchive(true)
                  }
                }}
                type="button"
              >
                {isArchived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                className="admin-button admin-button-secondary admin-button-danger"
                disabled={archiveChannel.isPending}
                onClick={handleDelete}
                type="button"
              >
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </button>
            </div>
            <div className="flex gap-2">
              <button
                className="admin-button admin-button-secondary"
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="admin-button admin-button-primary"
                disabled={!toChannelSlug(label) || updateChannel.isPending}
                type="submit"
              >
                Save
              </button>
            </div>
          </div>
        </form>
      </Dialog>

      {/* The sanctioned nesting (docs/navigation/overview.md §7): a confirm over the
          already-open settings dialog above, in the blocking layer. */}
      <ConfirmDialog
        blocking
        body={`Are you sure you want to archive #${channel.label}? It will be hidden from the channel list. You can unarchive it later.`}
        confirmLabel="Archive"
        onCancel={() => setConfirmArchive(false)}
        onConfirm={() => void handleArchiveToggle()}
        open={confirmArchive}
        pending={archiveChannel.isPending}
        title="Archive channel?"
      />
    </>
  )
}
