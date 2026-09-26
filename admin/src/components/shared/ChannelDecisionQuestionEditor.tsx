import type { ChannelDecisionPolicy } from '@nessie/schemas'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRecord } from '../../lib/api-client'
import { agentSelectionLabel } from './AgentVisibilityPill'
import { FormField } from './FormField'
import { Input, Select, Textarea } from './FormControls'

type Question = ChannelDecisionPolicy['questions'][number]

type Props = {
  agents: AgentRecord[]
  errors: Readonly<Record<string, string>>
  index: number
  onChange: (question: Question) => void
  onRemove: () => void
  question: Question
}

export const ChannelDecisionQuestionEditor = ({
  agents, errors, index, onChange, onRemove, question,
}: Props) => {
  const { t } = useTranslation('channels')
  const path = `questions.${index}`
  const [expanded, setExpanded] = useState(index === 0 || question.id === '')
  const [expandedOutcomes, setExpandedOutcomes] = useState<Set<number>>(() => new Set([0]))
  useEffect(() => {
    const invalid = Object.keys(errors).filter((key) => key.startsWith(`${path}.`))
    if (invalid.length === 0) return
    setExpanded(true)
    setExpandedOutcomes((current) => new Set([
      ...current,
      ...invalid.filter((key) => key.startsWith(`${path}.options.`)).map((key) => Number(key.split('.')[3])),
    ]))
  }, [errors, path])
  const updateOption = (optionIndex: number, option: Question['options'][number]) => {
    onChange({
      ...question,
      options: question.options.map((current, i) => i === optionIndex ? option : current),
    })
  }

  return (
    <section aria-label={t('decisions.decisionGroup', { index: index + 1 })} className="grid min-w-0 gap-4 border-t border-[var(--bd)] pt-4">
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-semibold">
          {question.id || t('decisions.decisionNumber', { index: index + 1 })} · {t('decisions.outcomes', { count: question.options.length })}
        </summary>
        <div className="mt-4 grid min-w-0 gap-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">{t('decisions.decisionNumber', { index: index + 1 })}</h4>
            <button className="admin-button admin-button-secondary" onClick={onRemove} type="button">
              {t('decisions.removeDecision')}
            </button>
          </div>
          <FormField
            error={errors[`${path}.id`]}
            help={t('decisions.nameHelp')}
            label={t('decisions.decisionName')}
          >
            <Input
              maxLength={64}
              onChange={(event) => onChange({ ...question, id: event.target.value })}
              value={question.id}
            />
          </FormField>
          <FormField error={errors[`${path}.instructions`]} label={t('decisions.question')}>
            <Textarea
              maxLength={4000}
              onChange={(event) => onChange({ ...question, instructions: event.target.value })}
              placeholder={t('decisions.questionPlaceholder')}
              rows={2}
              value={question.instructions}
            />
          </FormField>
          <p className="text-xs text-[color:var(--tx3)]">
          {t('decisions.outcomeHelp')}
          </p>
          {errors[`${path}.options`] ? <p className="text-sm text-[color:var(--danger-text)]" role="alert">
            {errors[`${path}.options`]}
          </p> : null}
          {question.options.map((option, optionIndex) => (
            <details
              key={optionIndex}
              open={expandedOutcomes.has(optionIndex)}
              onToggle={(event) => {
                const isOpen = event.currentTarget.open
                setExpandedOutcomes((current) => {
                  if (current.has(optionIndex) === isOpen) return current
                  const next = new Set(current)
                  if (isOpen) next.add(optionIndex)
                  else next.delete(optionIndex)
                  return next
                })
              }}
            >
              <summary className="cursor-pointer break-words text-sm">
                {option.id || t('decisions.outcomeNumber', { index: optionIndex + 1 })} · {option.followUp ? t('decisions.agentFollowUp') : t('decisions.noFurtherWork')}
              </summary>
              <div className="mt-3 grid min-w-0 gap-3" role="group" aria-label={t('decisions.outcomeNumber', { index: optionIndex + 1 })}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[color:var(--tx3)]">{t('decisions.outcomeNumber', { index: optionIndex + 1 })}</span>
                  <button
                    aria-label={t('decisions.removeOutcome', { index: optionIndex + 1 })}
                    className="admin-button admin-button-secondary admin-button-compact"
                    disabled={question.options.length <= 2}
                onClick={() => onChange({
                  ...question, options: question.options.filter((_, i) => i !== optionIndex),
                })}
                    type="button"
                  >
                    {t('decisions.remove')}
                  </button>
                </div>
                <FormField error={errors[`${path}.options.${optionIndex}.id`]} label={t('decisions.outcomeName')}>
                  <Input
                    maxLength={64}
                    onChange={(event) => updateOption(optionIndex, { ...option, id: event.target.value })}
                    placeholder={t('decisions.outcomePlaceholder')}
                    value={option.id}
                  />
                </FormField>
                <FormField error={errors[`${path}.options.${optionIndex}.description`]} label={t('decisions.whenChooseOutcome')}>
                  <Textarea
                    maxLength={1000}
                    onChange={(event) => updateOption(optionIndex, { ...option, description: event.target.value })}
                    rows={2}
                    value={option.description}
                  />
                </FormField>
                <FormField
                  error={errors[`${path}.options.${optionIndex}.followUp.agentId`]}
                  help={agents.length === 0 ? t('decisions.addAgentHelp') : undefined}
                  label={t('decisions.nextAction')}
                >
                  <Select
                    onChange={(event) => {
                      const { followUp, ...rest } = option
                      updateOption(optionIndex, event.target.value ? {
                        ...rest,
                        followUp: { agentId: event.target.value, instructions: followUp?.instructions ?? '' },
                      } : rest)
                    }}
                    value={option.followUp?.agentId ?? ''}
                  >
                    <option value="">{t('decisions.noFurtherWork')}</option>
                    {option.followUp && !agents.some((agent) => agent.id === option.followUp?.agentId) ? (
                      <option disabled value={option.followUp.agentId}>{t('decisions.agentUnavailable')}</option>
                    ) : null}
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {t('decisions.askAgent', { agent: agentSelectionLabel(agent.name, agent.visibility) })}
                        {agents.some((other) => other.id !== agent.id
                          && other.name === agent.name && other.visibility === agent.visibility)
                          ? ` (${agent.id.slice(0, 8)})` : ''}
                      </option>
                    ))}
                  </Select>
                </FormField>
                {option.followUp ? (
                  <FormField error={errors[`${path}.options.${optionIndex}.followUp.instructions`]} label={t('decisions.agentWork')}>
                    <Textarea
                      maxLength={4000}
                      onChange={(event) => updateOption(optionIndex, {
                        ...option,
                        followUp: { ...option.followUp!, instructions: event.target.value },
                      })}
                      placeholder={t('decisions.workPlaceholder')}
                      rows={3}
                      value={option.followUp.instructions}
                    />
                  </FormField>
                ) : null}
              </div>
            </details>
          ))}
          <button
            className="admin-button admin-button-secondary justify-self-start"
            disabled={question.options.length >= 16}
            onClick={() => {
              setExpandedOutcomes((current) => new Set([...current, question.options.length]))
              onChange({ ...question, options: [...question.options, { id: '', description: '' }] })
            }}
            type="button"
          >
            {t('decisions.addOutcome')}
          </button>
        </div>
      </details>
    </section>
  )
}
