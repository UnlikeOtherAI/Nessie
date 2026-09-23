import { useState } from 'react'
import {
  DeepWaterBriefContextSchema,
  DeepWaterBriefTopicSchema,
  type DeepWaterBriefOriginRequest,
} from '@nessie/schemas'
import { useDeepWaterViewerScope } from '../../../facades/deep-water/hooks'
import { useCreateResearchBrief } from '../../../facades/deep-water/mutations'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import { FormField } from '../../shared/FormField'
import { Textarea } from '../../shared/FormControls'
import { newBriefFailure } from './brief-action-errors'
import { reviveHeldActionId, type HeldActionId } from './intent-action-ids'
import { useStoredIntentActionId } from './useIntentActionId'

/**
 * The start of a brief: the question, and anything the planner should know.
 * Nothing else is asked here — DeepWater's planner answers with questions, the
 * pillars and the settings, and the person agrees them in the brief itself.
 * A create form cannot flush to a server before it is sent, so it keeps a
 * local draft per person and place
 * (`draft:research-brief-new:<user>:<organisation>:<place>`), never one a
 * second person on the same browser would be shown.
 *
 * The draft also holds the key the question was last sent with, until the
 * server has answered it: a lost answer may still have opened the brief, so
 * pressing Plan with DeepWater again — after closing the dialog or reloading —
 * sends the same key, and the server answers with that brief instead of
 * opening, and paying for, a second one.
 */

type NewBriefDraft = { context: string; held: HeldActionId | null; topic: string }

/** One draft per place a brief comes back to: a conversation, one of its reply threads, or the PA. */
const originKey = (origin: DeepWaterBriefOriginRequest): string => {
  if (origin.kind === 'personal') return 'personal'
  return origin.rootMessageId ? `${origin.threadId}:${origin.rootMessageId}` : origin.threadId
}

const reviveNewBrief = (stored: unknown): NewBriefDraft | null => {
  if (!stored || typeof stored !== 'object') return null
  const record = stored as Record<string, unknown>
  return {
    context: typeof record.context === 'string' ? record.context : '',
    held: reviveHeldActionId(record.held),
    topic: typeof record.topic === 'string' ? record.topic : '',
  }
}

export const ResearchBriefNewForm = ({
  initialTopic,
  onCreated,
  origin,
}: {
  initialTopic: string
  onCreated: (runId: string) => void
  origin: DeepWaterBriefOriginRequest
}) => {
  const create = useCreateResearchBrief()
  const scope = useDeepWaterViewerScope()
  const [error, setError] = useState<string | null>(null)
  // A doorway's question (the composer's text, "Start again") is the form's
  // baseline: it fills an empty form, but a draft the person already wrote
  // here is restored over it, and an untouched prefill is never stored.
  const { draft, setDraft, clear, flush } = useDraft<NewBriefDraft>(
    draftKey(
      'research-brief-new',
      scope ? `${scope.userId}:${scope.organizationId}:${originKey(origin)}` : null,
    ),
    {
      initial: { context: '', held: null, topic: initialTopic },
      revive: reviveNewBrief,
    },
  )
  // Stored at once, not on the draft's debounce: the key must be kept before
  // the request that carries it leaves.
  const actionId = useStoredIntentActionId(draft.held, (held) => {
    setDraft((current) => ({ ...current, held }))
    void flush()
  })
  const topic = draft.topic
  const topicValid = DeepWaterBriefTopicSchema.safeParse(topic).success
  const contextValid = DeepWaterBriefContextSchema.safeParse(draft.context).success

  const submit = () => {
    if (!topicValid || !contextValid || create.isPending) return
    setError(null)
    const context = draft.context.trim()
    const body = { origin, topic: topic.trim(), ...(context ? { context } : {}) }
    const id = actionId.take(body)
    create.mutate({ actionId: id, ...body }, {
      onError: (failure) => {
        const read = newBriefFailure(failure)
        actionId.settle(read.retrySameAction)
        setError(read.message)
      },
      onSuccess: (brief) => {
        actionId.settle(false)
        clear()
        onCreated(brief.id)
      },
    })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="research-brief-new">
      <FormField
        help="Ask the question you want answered. DeepWater’s research planner will reply with questions and a plan."
        label="What do you want to research?"
        required
      >
        <Textarea
          className="min-h-28"
          maxLength={20_000}
          onChange={(event) => setDraft((current) => ({ ...current, topic: event.target.value }))}
          value={topic}
        />
      </FormField>
      <FormField help="Optional: who it’s for, what you already know, or what to leave out." label="Background">
        <Textarea
          className="min-h-20"
          maxLength={50_000}
          onChange={(event) => setDraft((current) => ({ ...current, context: event.target.value }))}
          value={draft.context}
        />
      </FormField>
      {error ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">{error}</p> : null}
      <div className="flex justify-end border-t border-[color:var(--sep)] pt-3">
        <button
          className="admin-button admin-button-primary"
          disabled={!topicValid || !contextValid || create.isPending}
          onClick={submit}
          type="button"
        >
          {create.isPending ? 'Sending…' : 'Plan with DeepWater'}
        </button>
      </div>
    </div>
  )
}
