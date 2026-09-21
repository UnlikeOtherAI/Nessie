import type { ChannelDecisionPolicy } from '@nessie/schemas'
import type { AgentRecord } from '../../lib/api-client'
import { ChannelDecisionQuestionEditor } from './ChannelDecisionQuestionEditor'
import { FormField } from './FormField'
import { Input, Textarea } from './FormControls'

type Props = {
  agents: AgentRecord[]
  errors: Readonly<Record<string, string>>
  onChange: (policy: ChannelDecisionPolicy) => void
  policy: ChannelDecisionPolicy
}

/** The channel's one policy editor; the settings dialog owns saving. */
export const ChannelDecisionPolicyEditor = ({ agents, errors, onChange, policy }: Props) => (
  <section aria-label="Agent decisions" className="grid min-w-0 gap-4">
    <p className="text-sm text-[color:var(--tx2)]">
      Jev helps agents choose when to reply, acknowledge a message, or do follow-up work.
      Set the choices that matter in this channel.
    </p>
    <label className="flex items-center gap-3 text-sm font-semibold">
      <input
        checked={policy.enabled}
        onChange={(event) => onChange({ ...policy, enabled: event.target.checked })}
        type="checkbox"
      />
      Use Jev for this channel
    </label>
    <p className="text-xs text-[color:var(--tx3)]">
      {policy.enabled
        ? 'Saving enables these decisions for new messages. Follow-up work uses the selected agent’s existing access and approvals.'
        : 'These choices stay saved while Jev is off. Agents use their usual response decisions.'}
    </p>
    <FormField error={errors.instructions} label="Channel guidance">
      <Textarea
        maxLength={4000}
        onChange={(event) => onChange({ ...policy, instructions: event.target.value })}
        rows={3}
        value={policy.instructions}
      />
    </FormField>
    <FormField
      error={errors.minimumProbability}
      help="Below this confidence, Jev leaves the message alone."
      label="Minimum confidence (%)"
    >
      <Input
        className="max-w-32"
        max={100}
        min={0}
        onChange={(event) => onChange({ ...policy, minimumProbability: event.target.valueAsNumber / 100 })}
        step={1}
        type="number"
        value={Number.isNaN(policy.minimumProbability) ? '' : Math.round(policy.minimumProbability * 100)}
      />
    </FormField>

    <details open={Object.keys(errors).some((path) => path.startsWith('reactions.')) || undefined}>
      <summary className="cursor-pointer text-sm font-semibold">Acknowledgements ({policy.reactions.length})</summary>
      <div className="mt-4 grid gap-4">
        <p className="text-xs text-[color:var(--tx3)]">Choose which reactions agents may use and what each one means here.</p>
        {policy.reactions.map((reaction, index) => (
          <div aria-label={`Reaction ${index + 1}`} className="grid gap-3" key={index} role="group">
            <div className="flex items-end gap-2">
              <FormField className="min-w-0 flex-1" error={errors[`reactions.${index}.emoji`]} label="Reaction">
                <Input
                  maxLength={32}
                  onChange={(event) => onChange({
                    ...policy,
                    reactions: policy.reactions.map((current, i) =>
                      i === index ? { ...current, emoji: event.target.value } : current),
                  })}
                  value={reaction.emoji}
                />
              </FormField>
              <button
                aria-label={`Remove reaction ${index + 1}`}
                className="admin-button admin-button-secondary"
                onClick={() => onChange({ ...policy, reactions: policy.reactions.filter((_, i) => i !== index) })}
                type="button"
              >
                Remove
              </button>
            </div>
            <FormField error={errors[`reactions.${index}.description`]} label="When to use it">
              <Input
                maxLength={500}
                onChange={(event) => onChange({
                  ...policy,
                  reactions: policy.reactions.map((current, i) =>
                    i === index ? { ...current, description: event.target.value } : current),
                })}
                value={reaction.description}
              />
            </FormField>
          </div>
        ))}
        <button
          className="admin-button admin-button-secondary justify-self-start"
          disabled={policy.reactions.length >= 16}
          onClick={() => onChange({ ...policy, reactions: [...policy.reactions, { emoji: '', description: '' }] })}
          type="button"
        >
          Add reaction
        </button>
      </div>
    </details>

    <div className="grid gap-4">
      <div>
        <h3 className="text-sm font-semibold">Decisions and follow-up work</h3>
        <p className="mt-1 text-xs text-[color:var(--tx3)]">
          Ask a question and define its possible outcomes, such as confirmed, proposed, superseded or unrelated.
        </p>
      </div>
      {policy.questions.map((question, index) => (
        <ChannelDecisionQuestionEditor
          agents={agents}
          errors={errors}
          index={index}
          key={index}
          onChange={(next) => onChange({
            ...policy, questions: policy.questions.map((current, i) => i === index ? next : current),
          })}
          onRemove={() => onChange({ ...policy, questions: policy.questions.filter((_, i) => i !== index) })}
          question={question}
        />
      ))}
      <button
        className="admin-button admin-button-secondary justify-self-start"
        disabled={policy.questions.length >= 8}
        onClick={() => onChange({
          ...policy,
          questions: [...policy.questions, {
            id: '', instructions: '', options: [{ id: '', description: '' }, { id: 'unrelated', description: 'This message is unrelated to the question.' }],
          }],
        })}
        type="button"
      >
        Add decision
      </button>
    </div>
  </section>
)
