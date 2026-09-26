import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { faTrash } from '@fortawesome/free-solid-svg-icons'
import { useNavigate, useParams } from 'react-router-dom'
import { useAgents } from '../../facades/agents/hooks'
import { useChannels } from '../../facades/channels/hooks'
import { useProjects } from '../../facades/projects/hooks'
import {
  useActivateStatus,
  useCreateStatusRule,
  useCreateStatusSchedule,
  useDeleteStatus,
  useDeleteStatusRule,
  useDeleteStatusSchedule,
  useStatuses,
  useUpdateStatus,
} from '../../facades/statuses/hooks'
import { toFormErrors } from '../../facades/forms/form-errors'
import type { PageHeaderAction } from '../../components/shared/ResponsivePageHeader'
import { Card } from '../../components/shared/Card'
import { ConfirmDialog } from '../../components/shared/ConfirmDialog'
import { FormActions, FormError } from '../../components/shared/FormActions'
import { FormField } from '../../components/shared/FormField'
import { Input, Textarea } from '../../components/shared/FormControls'
import { QueryState } from '../../components/shared/QueryState'
import { SettingsPanel } from '../../components/shared/SettingsPanel'
import { Pill } from '../../components/primitives/Pill'
import { SectionLabel } from '../../components/primitives/SectionLabel'
import { Switch } from '../../components/primitives/Switch'
import { StatusEmojiPicker } from './statuses/StatusEmojiPicker'
import { StatusRuleForm } from './statuses/StatusRuleForm'
import { StatusScheduleForm } from './statuses/StatusScheduleForm'

/**
 * One status: what it is called, whether its response agent answers, and the
 * schedules and contact rules that make it worth having.
 *
 * Reached by opening a row in the Statuses table. "Set active" and Delete are
 * the screen's own header actions rather than controls buried in the editor,
 * so what changes the world sits apart from what edits a draft.
 */
export const StatusDetailPage = () => {
  const { t } = useTranslation('settings')
  const navigate = useNavigate()
  const { statusId } = useParams<{ statusId?: string }>()
  const statuses = useStatuses()
  const statusRows = useMemo(() => statuses.data ?? [], [statuses.data])
  const status = statusRows.find((candidate) => candidate.id === statusId)

  const { data: channels = [] } = useChannels()
  const { data: projects = [] } = useProjects()
  const { data: agents = [] } = useAgents()

  const updateStatus = useUpdateStatus()
  const deleteStatus = useDeleteStatus()
  const activateStatus = useActivateStatus()
  const createSchedule = useCreateStatusSchedule()
  const deleteSchedule = useDeleteStatusSchedule()
  const createRule = useCreateStatusRule()
  const deleteRule = useDeleteStatusRule()

  const [label, setLabel] = useState('')
  const [emoji, setEmoji] = useState('')
  const [agentEnabled, setAgentEnabled] = useState(false)
  const [agentInstructions, setAgentInstructions] = useState('')
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // Seed the editor once per status (key on id only). Keying on every field
  // would let a background ['statuses'] refetch — e.g. after toggling active —
  // overwrite the reader's in-progress edits.
  useEffect(() => {
    setLabel(status?.label ?? '')
    setEmoji(status?.emoji ?? '')
    setAgentEnabled(status?.agentEnabled ?? false)
    setAgentInstructions(status?.agentInstructions ?? '')
    setSaveError(undefined)
    setConfirmingDelete(false)
    // The four fields are read at this render, never depended on — see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.id])

  const backToList = () => void navigate('/settings/statuses')

  if (!status) {
    // The header is rendered here too: loading, failure and not-found are
    // states of this screen, and a phone with no header has no Back at all.
    return (
      <SettingsPanel backLabel={t('statuses.back')} eyebrow={t('statuses.title')} onBack={backToList} title={t('statuses.status')}>
        <QueryState
          className="py-12"
          emptyLabel={t('statuses.notFound')}
          errorLabel={t('statuses.loadFailed')}
          isEmpty
          loadingLabel={t('statuses.loading')}
          query={statuses}
        >
          {() => null}
        </QueryState>
      </SettingsPanel>
    )
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!label.trim()) return
    setSaveError(undefined)
    try {
      await updateStatus.mutateAsync({
        agentEnabled,
        agentInstructions: agentInstructions.trim() || null,
        emoji: emoji.trim() || null,
        label: label.trim(),
        statusId: status.id,
      })
    } catch (error) {
      const { fieldErrors, formError } = toFormErrors(error)
      setSaveError(fieldErrors.label ?? formError ?? t('statuses.saveFailed'))
    }
  }

  const remove = async () => {
    setConfirmingDelete(false)
    await deleteStatus.mutateAsync(status.id)
    void navigate('/settings/statuses', { replace: true })
  }

  const actions: PageHeaderAction[] = [
    {
      icon: faTrash,
      id: 'delete-status',
      label: deleteStatus.isPending ? t('statuses.deleting') : t('statuses.deleteStatus'),
      onSelect: () => setConfirmingDelete(true),
      priority: 10,
    },
    ...(status.activeNow
      ? []
      : [{
        id: 'set-active',
        label: t('statuses.setActive'),
        onSelect: () => activateStatus.mutate(status.id),
        primary: true,
        priority: 100,
      } satisfies PageHeaderAction]),
  ]

  return (
    <SettingsPanel
      actions={actions}
      backLabel={t('statuses.back')}
      eyebrow={t('statuses.title')}
      onBack={backToList}
      subtitle={
        <div className="flex flex-wrap items-center gap-2">
          <Pill height="control" tone={status.activeNow ? 'success' : 'muted'} uppercase={false}>
            {status.activeNow ? t('statuses.currentlyVisible') : t('statuses.notCurrentlyVisible')}
          </Pill>
          <p className="text-sm text-[color:var(--tx3)]">
            {t('statuses.scheduleCount', { count: status.schedules.length })}
            {' · '}
            {t('statuses.contactRuleCount', { count: status.rules.length })}
          </p>
        </div>
      }
      title={status.label}
    >
      <div className="grid max-w-3xl gap-4">
        <Card as="section">
          <form className="grid gap-4" onSubmit={save}>
            <SectionLabel>{t('statuses.statusDetail')}</SectionLabel>
            <div className="grid gap-3 md:grid-cols-[90px_minmax(0,1fr)]">
              <FormField label={t('statuses.icon')}>
                <StatusEmojiPicker label={t('statuses.statusIcon')} onChange={setEmoji} value={emoji} />
              </FormField>
              <FormField label={t('statuses.label')}>
                <Input
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('statuses.statusLabelPlaceholder')}
                  value={label}
                />
              </FormField>
            </div>
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-semibold text-[color:var(--tx)]">{t('statuses.enableResponseAgent')}</div>
                <div className="text-sm text-[color:var(--tx3)]">
                  {t('statuses.responseAgentDescription')}
                </div>
              </div>
              <Switch
                checked={agentEnabled}
                label={t('statuses.enableResponseAgent')}
                onChange={setAgentEnabled}
              />
            </div>
            <FormField label={t('statuses.agentInstructions')}>
              <Textarea
                className="min-h-28"
                onChange={(event) => setAgentInstructions(event.target.value)}
                placeholder={t('statuses.agentInstructionsPlaceholder')}
                value={agentInstructions}
              />
            </FormField>
            <FormError>{saveError}</FormError>
            <FormActions>
              <button className="admin-button admin-button-primary" type="submit">
                {t('statuses.saveStatus')}
              </button>
            </FormActions>
          </form>
        </Card>

        <StatusScheduleForm
          createSchedule={createSchedule}
          deleteSchedule={deleteSchedule}
          selectedStatus={status}
        />

        <StatusRuleForm
          agents={agents}
          channels={channels}
          createRule={createRule}
          deleteRule={deleteRule}
          projects={projects}
          selectedStatus={status}
        />
      </div>

      <ConfirmDialog
        body={t('statuses.deleteConfirmation')}
        confirmLabel={t('common.delete')}
        destructive
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => void remove()}
        open={confirmingDelete}
        pending={deleteStatus.isPending}
        title={t('statuses.deleteConfirmationTitle', { label: status.label })}
      />
    </SettingsPanel>
  )
}
