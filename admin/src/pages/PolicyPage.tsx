import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
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

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* The header is always rendered: a refusal is a state of this screen,
          not a screen of its own, so Back never disappears with it. */}
      <ScreenHeader title="Policy Rules" />
      <OwnerGate>
        <PageBody>
          <Section title="Create rule">
            <Card variant="section">
              <form className="grid gap-3" onSubmit={handleCreate}>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <FormField error={createErrors.fieldErrors.resourceType} label="Resource type" required>
                    <Select onChange={(e) => setNewResourceType(e.target.value)} value={newResourceType}>
                      {RESOURCE_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField error={createErrors.fieldErrors.action} label="Action" required>
                    <Select onChange={(e) => setNewAction(e.target.value)} value={newAction}>
                      {ACTIONS.map((a) => (
                        <option key={a} value={a}>
                          {a}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField error={createErrors.fieldErrors.effect} label="Effect" required>
                    <Select onChange={(e) => setNewEffect(e.target.value)} value={newEffect}>
                      <option value="allow">Allow</option>
                      <option value="deny">Deny</option>
                    </Select>
                  </FormField>
                  <FormField
                    error={createErrors.fieldErrors.bindings}
                    help="Use * to match everyone."
                    label="Actor ID"
                    required
                  >
                    <Input
                      onChange={(e) => setNewActorId(e.target.value)}
                      placeholder="Actor ID (* for all)"
                      value={newActorId}
                    />
                  </FormField>
                </div>

                <FormError>{createErrors.formError}</FormError>

                <FormActions>
                  <button className="admin-button admin-button-primary" disabled={createRule.isPending} type="submit">
                    Create rule
                  </button>
                </FormActions>
              </form>
            </Card>
          </Section>

          <Section title="Rules">
            <FormError>{deleteErrors.formError}</FormError>

            <QueryState
              emptyLabel="No policy rules configured"
              errorLabel="Policy rules could not be loaded."
              isEmpty={rows.items.length === 0}
              loadingLabel="Loading policy rules…"
              query={rows.query}
            >
              {() => (
                <>
                  <RowList label="Policy rules">
                    {rows.items.map((rule) => (
                      <Row
                        key={rule.id}
                        subtitle={
                          `${rule.scope}:${rule.scopeId.slice(0, 8)} → `
                          + `${rule.bindings.map((b) => `${b.actorType}:${b.actorId}`).join(', ')} · priority ${rule.priority}`
                        }
                        title={
                          <span className="flex items-center gap-2">
                            <Pill radius="chip" size="sm" tone={rule.effect === 'allow' ? 'success' : 'danger'}>
                              {rule.effect}
                            </Pill>
                            <span className="font-mono text-[color:var(--tx)]">
                              {rule.resourceType}.{rule.action}
                            </span>
                          </span>
                        }
                        trailing={
                          <button
                            className="text-xs text-[color:var(--danger-text)] hover:text-[color:var(--danger)]"
                            onClick={() => setPendingDeleteId(rule.id)}
                            type="button"
                          >
                            Delete
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
              ? `${pendingDeleteRule.resourceType}.${pendingDeleteRule.action} for ${pendingDeleteRule.scope}:${pendingDeleteRule.scopeId.slice(0, 8)} will stop applying immediately.`
              : undefined
          }
          confirmLabel="Delete rule"
          destructive
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => {
            if (pendingDeleteId) deleteRule.mutate(pendingDeleteId)
          }}
          open={pendingDeleteId !== null}
          pending={deleteRule.isPending}
          title="Delete this policy rule?"
        />
      </OwnerGate>
    </section>
  )
}
