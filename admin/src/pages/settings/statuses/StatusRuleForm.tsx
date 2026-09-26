import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentRecord,
  ChannelRecord,
  ProjectRecord,
  UserStatusRecord,
  UserStatusRuleScope,
} from '../../../lib/api-client'
import type { useCreateStatusRule, useDeleteStatusRule } from '../../../facades/statuses/hooks'
import { toFormErrors } from '../../../facades/forms/form-errors'
import { agentSelectionLabel } from '../../../components/shared/AgentVisibilityPill'
import { Card } from '../../../components/shared/Card'
import { EmptyState } from '../../../components/shared/EmptyState'
import { FormActions, FormError } from '../../../components/shared/FormActions'
import { FormField } from '../../../components/shared/FormField'
import { Select, Textarea } from '../../../components/shared/FormControls'
import { Row, RowList } from '../../../components/shared/RowList'
import { SectionLabel } from '../../../components/primitives/SectionLabel'
import { Switch } from '../../../components/primitives/Switch'
import { describeRule } from './status-presentation'

type StatusRuleFormProps = {
  agents: AgentRecord[]
  channels: ChannelRecord[]
  createRule: ReturnType<typeof useCreateStatusRule>
  deleteRule: ReturnType<typeof useDeleteStatusRule>
  projects: ProjectRecord[]
  selectedStatus: UserStatusRecord
}

/**
 * The contact-rule form + list for the selected status: who reaches this
 * status agent, and under what instructions. Split out of `StatusesPage.tsx`
 * (06-F6), which held this alongside two other unrelated forms sharing
 * nothing but the selected status.
 */
export const StatusRuleForm = ({
  agents,
  channels,
  createRule,
  deleteRule,
  projects,
  selectedStatus,
}: StatusRuleFormProps) => {
  const { t } = useTranslation('settings')
  const [ruleScope, setRuleScope] = useState<UserStatusRuleScope>('fallback')
  const [ruleChannelId, setRuleChannelId] = useState('')
  const [ruleProjectId, setRuleProjectId] = useState('')
  const [ruleAgentId, setRuleAgentId] = useState('')
  const [ruleAgentEnabled, setRuleAgentEnabled] = useState(true)
  const [ruleInstructions, setRuleInstructions] = useState('')
  const [ruleError, setRuleError] = useState<string | undefined>(undefined)

  const ruleTargetReady =
    ruleScope === 'fallback' ||
    (ruleScope === 'channel' && Boolean(ruleChannelId)) ||
    (ruleScope === 'project' && Boolean(ruleProjectId))

  const ruleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!ruleInstructions.trim()) return
    setRuleError(undefined)
    try {
      await createRule.mutateAsync({
        agentEnabled: ruleAgentEnabled,
        agentId: ruleAgentId || null,
        channelId: ruleScope === 'channel' ? ruleChannelId || null : null,
        instructions: ruleInstructions.trim(),
        projectId: ruleScope === 'project' ? ruleProjectId || null : null,
        scope: ruleScope,
        statusId: selectedStatus.id,
      })
      setRuleInstructions('')
    } catch (error) {
      setRuleError(toFormErrors(error).formError ?? t('statuses.addRuleFailed'))
    }
  }

  return (
    <Card as="section">
      <SectionLabel>{t('statuses.contactRules')}</SectionLabel>
      <form className="mt-4 grid gap-3" onSubmit={ruleSubmit}>
        <div className="grid gap-2 md:grid-cols-3">
          <FormField label={t('statuses.appliesTo')}>
            <Select
              onChange={(event) => setRuleScope(event.target.value as UserStatusRuleScope)}
              value={ruleScope}
            >
              <option value="fallback">{t('statuses.everyone')}</option>
              <option value="channel">{t('statuses.channel')}</option>
              <option value="project">{t('statuses.project')}</option>
            </Select>
          </FormField>
          {ruleScope === 'channel' && (
            <FormField className="md:col-span-2" label={t('statuses.channel')}>
              <Select
                onChange={(event) => setRuleChannelId(event.target.value)}
                value={ruleChannelId}
              >
                <option value="">{t('statuses.selectChannel')}</option>
                {channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.label}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          {ruleScope === 'project' && (
            <FormField className="md:col-span-2" label={t('statuses.project')}>
              <Select
                onChange={(event) => setRuleProjectId(event.target.value)}
                value={ruleProjectId}
              >
                <option value="">{t('statuses.selectProject')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </div>
        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <FormField label={t('statuses.agent')}>
            <Select
              onChange={(event) => setRuleAgentId(event.target.value)}
              value={ruleAgentId}
            >
              <option value="">{t('statuses.defaultAgent')}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agentSelectionLabel(agent.name, agent.visibility)}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="flex items-center gap-3 self-end pb-2">
            <span className="text-sm text-[color:var(--tx2)]">{t('statuses.agentReplies')}</span>
            <Switch
              checked={ruleAgentEnabled}
              label={t('statuses.enableRuleAgent')}
              onChange={setRuleAgentEnabled}
            />
          </div>
        </div>
        <FormField label={t('statuses.instructions')}>
          <Textarea
            className="min-h-24"
            onChange={(event) => setRuleInstructions(event.target.value)}
            placeholder={t('statuses.ruleInstructionsPlaceholder')}
            value={ruleInstructions}
          />
        </FormField>
        <FormError>{ruleError}</FormError>
        <FormActions>
          <button
            className="admin-button admin-button-secondary"
            disabled={!ruleTargetReady || !ruleInstructions.trim()}
            type="submit"
          >
            {t('statuses.addRule')}
          </button>
        </FormActions>
      </form>
      <div className="mt-4">
        {selectedStatus.rules.length > 0 ? (
          <RowList label={t('statuses.contactRules')}>
            {selectedStatus.rules.map((rule) => (
              <Row
                key={rule.id}
                subtitle={
                  <span className="line-clamp-2">{rule.instructions}</span>
                }
                title={describeRule(rule, channels, projects, agents)}
                trailing={
                  <button
                    className="admin-button admin-button-secondary"
                    onClick={() =>
                      deleteRule.mutate({ ruleId: rule.id, statusId: selectedStatus.id })}
                    type="button"
                  >
                    {t('common.remove')}
                  </button>
                }
              />
            ))}
          </RowList>
        ) : (
          <EmptyState>{t('statuses.noContactRules')}</EmptyState>
        )}
      </div>
    </Card>
  )
}
