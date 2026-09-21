import { useState } from 'react'
import type { PreparedExecutorAccessChangeResponse } from '@nessie/schemas'
import type { ExecutorAccessViewWithLocalMcp } from '../../../facades/executors/local-mcp'
import { usePrepareExecutorAccessChange } from '../../../facades/executors/hooks'
import { useUsers } from '../../../facades/users/hooks'
import { Dialog } from '../../shared/Dialog'
import { FormActions, FormError } from '../../shared/FormActions'
import { QueryState } from '../../shared/QueryState'

export const ExecutorPeopleDialog = ({ access, onClose, onPrepared }: {
  access: ExecutorAccessViewWithLocalMcp
  onClose: () => void
  onPrepared: (prepared: PreparedExecutorAccessChangeResponse) => void
}) => {
  const users = useUsers()
  const prepare = usePrepareExecutorAccessChange()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<'use' | 'admin'>('use')
  const [error, setError] = useState<string | null>(null)
  const assignments = (access.privateAssignments ?? []).filter((item) => item.principalKind === 'user')
  const submit = async (id: string, action: 'set' | 'remove') => {
    setError(null)
    try {
      const change = action === 'set'
        ? { kind: 'private_assignment', action, assignment: { principalKind: 'user', userId: id, role } }
        : { kind: 'private_assignment', action, principal: { principalKind: 'user', userId: id } }
      const prepared = await prepare.mutateAsync({ executorId: access.executorId, change })
      onClose()
      onPrepared(prepared)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The change could not be opened.') }
  }
  return (
    <Dialog dismissDisabled={prepare.isPending} onClose={onClose} open title="People who can use this machine">
      <QueryState errorLabel="People could not be loaded." loadingLabel="Loading people…" query={users}>
        {() => <div className="grid gap-4">
          <ul className="divide-y divide-[color:var(--sep)]">
            {assignments.map((assignment) => <li className="flex items-center justify-between gap-3 py-3" key={assignment.userId}>
              <div className="text-sm">
                <p>{users.data?.find((user) => user.id === assignment.userId)?.displayName ?? 'Former member'}</p>
                <p className="text-xs text-[color:var(--tx3)]">{assignment.role === 'admin' ? 'Administrator' : 'Can use'}</p>
              </div>
              <button className="admin-button admin-button-secondary" disabled={prepare.isPending}
                onClick={() => void submit(assignment.userId, 'remove')} type="button">Remove</button>
            </li>)}
          </ul>
          <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); if (userId) void submit(userId, 'set') }}>
            <label className="grid gap-1 text-sm">Person
              <select className="admin-input" onChange={(event) => setUserId(event.target.value)} required value={userId}>
                <option value="">Choose a person</option>
                {(users.data ?? []).map((user) => <option key={user.id} value={user.id}>{user.displayName}</option>)}
              </select>
            </label>
            <label className="grid gap-1 text-sm">Permission
              <select className="admin-input" onChange={(event) => setRole(event.target.value as 'use' | 'admin')} value={role}>
                <option value="use">Can use</option><option value="admin">Administrator</option>
              </select>
            </label>
            <FormError>{error}</FormError>
            <FormActions><button className="admin-button admin-button-primary" disabled={!userId || prepare.isPending} type="submit">Review change</button></FormActions>
          </form>
        </div>}
      </QueryState>
    </Dialog>
  )
}
