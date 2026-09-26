import {
  ChannelDecisionPolicySchema,
  DEFAULT_CHANNEL_DECISION_POLICY,
  type ChannelDecisionPolicy,
} from '@nessie/schemas'
import { useEffect, useState, type FormEvent } from 'react'
import { useUpdateChannel } from '../../../../facades/channels/hooks'
import type { AgentRecord, ChannelRecord } from '../../../../lib/api-client'
import { ChannelDecisionPolicyEditor } from '../../../shared/ChannelDecisionPolicyEditor'
import { FormActions, FormError, FormSuccess } from '../../../shared/FormActions'

const serialize = (policy: ChannelDecisionPolicy): string => JSON.stringify(policy)
const livePolicy = (channel: ChannelRecord): ChannelDecisionPolicy =>
  channel.decisionPolicy ?? DEFAULT_CHANNEL_DECISION_POLICY

type DetailsResponsesProps = {
  boundAgents: AgentRecord[]
  channel: ChannelRecord
}

/**
 * Details › How agents respond: the room's decision policy, whole, under a
 * name a person can read (docs/standards/channel-decision-policy.md).
 *
 * It saves only the policy, never the room's name or topic — General has its
 * own Save — and it keeps an unfinished edit across a refresh of the channel.
 * When the saved policy changes under an edit (another editor, or the
 * Personal Assistant's `channel_update`), saving waits for the person to load
 * the latest version: the update API has no revision to match atomically, so
 * this is the check. Somebody who may not change the room reads the policy
 * with every control disabled.
 */
export const DetailsResponses = ({ boundAgents, channel }: DetailsResponsesProps) => {
  const updateChannel = useUpdateChannel()
  const canManage = channel.viewerCanManage
  const [policy, setPolicy] = useState<ChannelDecisionPolicy>(() => livePolicy(channel))
  const [savedPolicy, setSavedPolicy] = useState(() => serialize(livePolicy(channel)))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const changed = serialize(policy) !== savedPolicy
  const conflict = changed && serialize(livePolicy(channel)) !== savedPolicy

  useEffect(() => {
    if (!saved) return
    const id = window.setTimeout(() => setSaved(false), 2500)
    return () => window.clearTimeout(id)
  }, [saved])

  const loadLatest = () => {
    const latest = livePolicy(channel)
    setPolicy(latest)
    setSavedPolicy(serialize(latest))
    setErrors({})
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canManage || !changed || conflict) return
    const parsed = ChannelDecisionPolicySchema.safeParse(policy)
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message])))
      return
    }
    setFormError(null)
    try {
      await updateChannel.mutateAsync({ channelId: channel.id, decisionPolicy: parsed.data })
      setSavedPolicy(serialize(parsed.data))
      setSaved(true)
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'The decisions could not be saved.')
    }
  }

  return (
    <form className="grid min-w-0 gap-4" noValidate onSubmit={(event) => void submit(event)}>
      {!canManage ? (
        <p className="text-sm text-[color:var(--tx3)]">
          Only members of this channel, or an organisation owner or admin, can change how its agents respond.
        </p>
      ) : null}
      {conflict ? (
        <div className="grid gap-2 text-sm" role="alert">
          <p>These decisions changed while you were editing. Load the latest version before saving.</p>
          <button className="admin-button admin-button-secondary justify-self-start" onClick={loadLatest} type="button">
            Load latest decisions
          </button>
        </div>
      ) : null}
      <fieldset className="min-w-0 border-0 p-0" disabled={!canManage}>
        <ChannelDecisionPolicyEditor
          agents={boundAgents}
          errors={errors}
          onChange={(next) => {
            setPolicy(next)
            setErrors({})
            setFormError(null)
          }}
          policy={policy}
        />
      </fieldset>
      <FormError>{formError ?? undefined}</FormError>
      <FormSuccess>{saved ? 'Saved.' : undefined}</FormSuccess>
      <FormActions>
        <button
          className="admin-button admin-button-primary"
          disabled={!canManage || !changed || conflict || updateChannel.isPending}
          type="submit"
        >
          {updateChannel.isPending ? 'Saving…' : 'Save'}
        </button>
      </FormActions>
    </form>
  )
}
