import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Pill } from '../components/primitives/Pill'
import { Card } from '../components/shared/Card'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { FormActions, FormError } from '../components/shared/FormActions'
import { FormField } from '../components/shared/FormField'
import { Select, Input } from '../components/shared/FormControls'
import { PageBody, Section } from '../components/shared/PageBody'
import { PaginationFooter } from '../components/shared/PaginationFooter'
import { QueryState } from '../components/shared/QueryState'
import { Row, RowList } from '../components/shared/RowList'
import { ScreenHeader } from '../components/shared/ScreenHeader'
import { OwnerGate } from '../components/shared/OwnerGate'
import { useIsOwner } from '../facades/auth/hooks'
import { EMPTY_FORM_ERRORS, toFormErrors } from '../facades/forms/form-errors'
import { policyKeys } from '../lib/query-keys'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'
import { usePagedList } from '../facades/pagination/usePagedList'

type PolicyRule = {
  id: string
  scope: string
  scopeId: string
  resourceType: string
  action: string
  effect: string
  priority: number
  conditions: Record<string, unknown> | null
  bindings: Array<{ id: string; actorType: string; actorId: string }>
  createdAt: string
}

const RESOURCE_TYPES = ['agent', 'channel', 'project', 'tool', 'session', 'task', 'admin']
const ACTIONS = ['view', 'invoke', 'create', 'edit', 'bind', 'admin', 'approve']

export const PolicyPage = () => {
  const { t } = useTranslation('operations')
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  // Still the page's own flag: the rules query below must stay disabled for a
  // non-owner, exactly as before OwnerGate wrapped the render.
  const isOwner = useIsOwner()

  const [newResourceType, setNewResourceType] = useState('agent')
  const [newAction, setNewAction] = useState('view')
  const [newEffect, setNewEffect] = useState('allow')
  const [newActorId, setNewActorId] = useState('*')
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

  // Not a raw key: `policyKeys.rules` is the factory; 'page' only distinguishes
  // this hook's own cache entry. See AuditLogPage's identical note.
  const cacheKey = [...policyKeys.rules, 'page']

  const rows = usePagedList<PolicyRule>({
    enabled: isOwner,
    path: '/api/policy/rules',
    queryKey: cacheKey,
  })

  const createRule = useMutation({
    mutationFn: (input: {
      resourceType: string
      action: string
      effect: string
      bindings: Array<{ actorType: string; actorId: string }>
    }) =>
      apiClient.post('/api/policy/rules', {
        scope: 'organization',
        scopeId: me?.context.organizationId,
        ...input,
        priority: 100,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: policyKeys.rules })
    },
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => apiClient.delete(`/api/policy/rules/${ruleId}`),
    onSuccess: () => {
      setPendingDeleteId(null)
      void queryClient.invalidateQueries({ queryKey: policyKeys.rules })
    },
  })

  const handleCreate = (e: FormEvent) => {
    e.preventDefault()
    createRule.mutate({
      resourceType: newResourceType,
      action: newAction,
      effect: newEffect,
      bindings: [{ actorType: 'role', actorId: newActorId }],
    })
  }

  const createErrors = createRule.isError ? toFormErrors(createRule.error) : EMPTY_FORM_ERRORS
  const deleteErrors = deleteRule.isError ? toFormErrors(deleteRule.error) : EMPTY_FORM_ERRORS
  const pendingDeleteRule = rows.items.find((rule) => rule.id === pendingDeleteId) ?? null
  const resourceLabels: Record<string, string> = {
    agent: t('policy.resource.agent'), channel: t('policy.resource.channel'),
    project: t('policy.resource.project'), tool: t('policy.resource.tool'),
    session: t('policy.resource.session'), task: t('policy.resource.task'),
    admin: t('policy.resource.admin'),
  }
  const actionLabels: Record<string, string> = {
    view: t('policy.action.view'), invoke: t('policy.action.invoke'),
    create: t('policy.action.create'), edit: t('policy.action.edit'),
    bind: t('policy.action.bind'), admin: t('policy.action.admin'),
    approve: t('policy.action.approve'),
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back never disappears with it. */}
      <ScreenHeader title={t('policy.title')} />
      <OwnerGate>
        <PageBody>
          <Section title={t('policy.createTitle')}>
            <Card variant="section">
              <form className="grid gap-3" onSubmit={handleCreate}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <FormField error={createErrors.fieldErrors.resourceType && t('policy.invalidResource')} label={t('policy.resourceType')} required>
                    <Select onChange={(e) => setNewResourceType(e.target.value)} value={newResourceType}>
                      {RESOURCE_TYPES.map((resource) => (
                        <option key={resource} value={resource}>
                          {resourceLabels[resource]}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField error={createErrors.fieldErrors.action && t('policy.invalidAction')} label={t('policy.actionLabel')} required>
                    <Select onChange={(e) => setNewAction(e.target.value)} value={newAction}>
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {actionLabels[a]}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField error={createErrors.fieldErrors.effect && t('policy.invalidEffect')} label={t('policy.effect')} required>
                    <Select onChange={(e) => setNewEffect(e.target.value)} value={newEffect}>
                      <option value="allow">{t('policy.allow')}</option>
                      <option value="deny">{t('policy.deny')}</option>
                    </Select>
                  </FormField>
                  <FormField
                    error={createErrors.fieldErrors.bindings && t('policy.invalidActor')}
                    help={t('policy.actorHelp')}
                    label={t('policy.actorId')}
                    required
                  >
                    <Input
                      onChange={(e) => setNewActorId(e.target.value)}
                      placeholder={t('policy.actorPlaceholder')}
                      value={newActorId}
                    />
                  </FormField>
                </div>

                <FormError>{createErrors.formError && t('policy.createFailed')}</FormError>

                <FormActions>
                  <button className="admin-button admin-button-primary" disabled={createRule.isPending} type="submit">
                    {t('policy.create')}
                  </button>
                </FormActions>
              </form>
            </Card>
          </Section>

          <Section title={t('policy.rules')}>
            <FormError>{deleteErrors.formError && t('policy.deleteFailed')}</FormError>

            <QueryState
              emptyLabel={t('policy.empty')}
              errorLabel={t('policy.loadFailed')}
              isEmpty={rows.items.length === 0}
              loadingLabel={t('policy.loading')}
              query={rows.query}
            >
              {() => (
                <>
                  <RowList label={t('policy.title')}>
                    {rows.items.map((rule) => (
                      <Row
                        key={rule.id}
                        subtitle={
                          t('policy.ruleSubtitle', {
                            scope: rule.scope === 'organization' ? t('policy.organisation') : rule.scope,
                            id: rule.scopeId.slice(0, 8),
                            bindings: rule.bindings.map((binding) => `${binding.actorType}:${binding.actorId}`).join(', '),
                            priority: rule.priority,
                          })
                        }
                        title={
                          <span className="flex items-center gap-2">
                            <Pill radius="chip" size="sm" tone={rule.effect === 'allow' ? 'success' : 'danger'}>
                              {rule.effect === 'allow' ? t('policy.allow') : t('policy.deny')}
                            </Pill>
                            <span className="font-mono text-[color:var(--tx)]">
                              {resourceLabels[rule.resourceType] ?? rule.resourceType}
                              .{actionLabels[rule.action] ?? rule.action}
                            </span>
                          </span>
                        }
                        trailing={
                          <button
                            className="text-xs text-[color:var(--danger-text)] hover:text-[color:var(--danger)]"
                            onClick={() => setPendingDeleteId(rule.id)}
                            type="button"
                          >
                            {t('policy.delete')}
                          </button>
                        }
                      />
                    ))}
                  </RowList>
                  <PaginationFooter
                    canNext={rows.canNext}
                    canPrevious={rows.canPrevious}
                    hideWhenSinglePage
                    label={rows.label}
                    onPageChange={rows.onPageChange}
                    onPageSizeChange={rows.onPageSizeChange}
                    page={rows.page}
                    pageCount={rows.pageCount}
                    pageSize={rows.pageSize}
                  />
                </>
              )}
            </QueryState>
          </Section>
        </PageBody>

        <ConfirmDialog
          body={
            pendingDeleteRule
              ? t('policy.deleteBody', {
                resource: resourceLabels[pendingDeleteRule.resourceType] ?? pendingDeleteRule.resourceType,
                action: actionLabels[pendingDeleteRule.action] ?? pendingDeleteRule.action,
                scope: pendingDeleteRule.scope === 'organization' ? t('policy.organisation') : pendingDeleteRule.scope,
                id: pendingDeleteRule.scopeId.slice(0, 8),
              })
              : undefined
          }
          confirmLabel={t('policy.deleteRule')}
          destructive
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => {
            if (pendingDeleteId) deleteRule.mutate(pendingDeleteId)
          }}
          open={pendingDeleteId !== null}
          pending={deleteRule.isPending}
          title={t('policy.deleteTitle')}
        />
      </OwnerGate>
    </section>
  )
}
