import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { AdminPageHeader } from '../components/shared/AdminPageHeader'
import { useApiClient } from '../providers/ApiClientProvider'
import { useAuthSession } from '../providers/AuthSessionProvider'

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

type PolicyRulesResponse = {
  data: PolicyRule[]
  meta: { cursor: string | null; hasMore: boolean }
}

const sectionTitle =
  'text-xs font-semibold uppercase tracking-[0.2em] text-[color:var(--tx3)]'

export const PolicyPage = () => {
  const { me } = useAuthSession()
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const isOwner = me?.user.roleIds.includes('owner') ?? false

  const [newResourceType, setNewResourceType] = useState('agent')
  const [newAction, setNewAction] = useState('view')
  const [newEffect, setNewEffect] = useState('allow')
  const [newActorId, setNewActorId] = useState('*')

  const { data } = useQuery<PolicyRulesResponse>({
    queryKey: ['policy-rules'],
    queryFn: () => apiClient.get('/api/policy/rules?limit=100'),
    enabled: isOwner,
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
      void queryClient.invalidateQueries({ queryKey: ['policy-rules'] })
    },
  })

  const deleteRule = useMutation({
    mutationFn: (ruleId: string) => apiClient.delete(`/api/policy/rules/${ruleId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['policy-rules'] })
    },
  })

  if (!isOwner) {
    return (
      <section className="flex h-full items-center justify-center text-[color:var(--tx3)]">
        Owner access required
      </section>
    )
  }

  const handleCreate = (e: FormEvent) => {
    e.preventDefault()
    createRule.mutate({
      resourceType: newResourceType,
      action: newAction,
      effect: newEffect,
      bindings: [{ actorType: 'role', actorId: newActorId }],
    })
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <AdminPageHeader title="Policy Rules" />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <form className="admin-card mb-4 grid gap-3 p-4" onSubmit={handleCreate}>
          <div className={sectionTitle}>Create Rule</div>
          <div className="grid grid-cols-4 gap-2">
            <select
              className="admin-input"
              onChange={(e) => setNewResourceType(e.target.value)}
              value={newResourceType}
            >
              {['agent', 'channel', 'project', 'tool', 'session', 'task', 'admin'].map(
                (t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ),
              )}
            </select>
            <select
              className="admin-input"
              onChange={(e) => setNewAction(e.target.value)}
              value={newAction}
            >
              {['view', 'invoke', 'create', 'edit', 'bind', 'admin', 'approve'].map(
                (a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ),
              )}
            </select>
            <select
              className="admin-input"
              onChange={(e) => setNewEffect(e.target.value)}
              value={newEffect}
            >
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
            <input
              className="admin-input"
              onChange={(e) => setNewActorId(e.target.value)}
              placeholder="Actor ID (* for all)"
              value={newActorId}
            />
          </div>
          <button
            className="admin-button admin-button-primary justify-self-start"
            disabled={createRule.isPending}
            type="submit"
          >
            Create Rule
          </button>
        </form>

        <div className="grid gap-2">
          {(data?.data ?? []).map((rule) => (
            <div key={rule.id} className="admin-card flex items-center justify-between p-3">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.16em]',
                      rule.effect === 'allow'
                        ? 'bg-[color:var(--success-soft)] text-[color:var(--success-text)]'
                        : 'bg-[color:var(--danger-soft)] text-[color:var(--danger-text)]',
                    ].join(' ')}
                  >
                    {rule.effect}
                  </span>
                  <span className="font-mono text-xs text-[color:var(--tx)]">
                    {rule.resourceType}.{rule.action}
                  </span>
                  <span className="text-xs text-[color:var(--tx3)]">
                    priority: {rule.priority}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[color:var(--tx2)]">
                  {rule.scope}:{rule.scopeId.slice(0, 8)} &rarr;{' '}
                  {rule.bindings.map((b) => `${b.actorType}:${b.actorId}`).join(', ')}
                </div>
              </div>
              <button
                className="text-xs text-[color:var(--danger-text)] hover:text-[color:var(--danger)]"
                onClick={() => deleteRule.mutate(rule.id)}
                type="button"
              >
                Delete
              </button>
            </div>
          ))}
          {(data?.data ?? []).length === 0 && (
            <div className="py-8 text-center text-[color:var(--tx3)]">
              No policy rules configured
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
