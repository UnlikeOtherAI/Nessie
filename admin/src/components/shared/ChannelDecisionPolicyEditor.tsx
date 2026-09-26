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
export const ChannelDecisionPolicyEditor = ({ agents, errors, onChange, policy }: Props) => {
  const { t } = useTranslation('channels')
  return (
  <section aria-label={t('decisions.title')} className="grid min-w-0 gap-4">
    <p className="text-sm text-[color:var(--tx2)]">
      {t('decisions.intro')}
    </p>
    <label className="flex items-center gap-3 text-sm font-semibold">
      <input
        checked={policy.enabled}
        onChange={(event) => onChange({ ...policy, enabled: event.target.checked })}
        type="checkbox"
      />
      {t('decisions.useJev')}
    </label>
    <p className="text-xs text-[color:var(--tx3)]">
      {policy.enabled
        ? t('decisions.enabledHelp')
        : t('decisions.disabledHelp')}
    </p>
    <FormField error={errors.instructions} label={t('decisions.guidance')}>
      <Textarea
        maxLength={4000}
        onChange={(event) => onChange({ ...policy, instructions: event.target.value })}
        rows={3}
        value={policy.instructions}
      />
    </FormField>
    <FormField
      error={errors.minimumProbability}
      help={t('decisions.confidenceHelp')}
      label={t('decisions.minimumConfidence')}
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
      <summary className="cursor-pointer text-sm font-semibold">{t('decisions.acknowledgements', { count: policy.reactions.length })}</summary>
      <div className="mt-4 grid gap-4">
        <p className="text-xs text-[color:var(--tx3)]">{t('decisions.reactionsHelp')}</p>
        {policy.reactions.map((reaction, index) => (
          <div aria-label={t('decisions.reactionGroup', { index: index + 1 })} className="grid gap-3" key={index} role="group">
            <div className="flex items-end gap-2">
              <FormField className="min-w-0 flex-1" error={errors[`reactions.${index}.emoji`]} label={t('decisions.reaction')}>
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
                aria-label={t('decisions.removeReaction', { index: index + 1 })}
                className="admin-button admin-button-secondary"
                onClick={() => onChange({ ...policy, reactions: policy.reactions.filter((_, i) => i !== index) })}
                type="button"
              >
                {t('decisions.remove')}
              </button>
            </div>
            <FormField error={errors[`reactions.${index}.description`]} label={t('decisions.whenToUse')}>
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
          {t('decisions.addReaction')}
        </button>
      </div>
    </details>

    <div className="grid gap-4">
      <div>
        <h3 className="text-sm font-semibold">{t('decisions.followUpTitle')}</h3>
        <p className="mt-1 text-xs text-[color:var(--tx3)]">
          {t('decisions.followUpHelp')}
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
        {t('decisions.addDecision')}
      </button>
    </div>
  </section>
  )
}
import { useTranslation } from 'react-i18next'
