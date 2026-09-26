import { useState } from 'react'

import { useExecutorSessionSharing } from '../../../facades/executors/session-sharing'
import { formErrorMessage } from '../../../facades/forms/form-errors'
import { Dialog } from '../../shared/Dialog'
import { QueryState } from '../../shared/QueryState'
import { FormError } from '../../shared/FormActions'

export const ExecutorSessionSharing = ({ executorId, sessionId, open, onClose }: {
  executorId: string; sessionId: string; open: boolean; onClose: () => void
}) => {
  const [email, setEmail] = useState('')
  const { query, change } = useExecutorSessionSharing(executorId, sessionId, open)
  return <Dialog open={open} onClose={onClose} title="Share session" dismissDisabled={change.isPending}
    description="People you add can see this session’s terminal output, including its scrollback. They cannot type or control it.">
    <div className="grid gap-4 p-4">
      <form className="grid gap-2" onSubmit={(event) => {
        event.preventDefault()
        change.mutate({ email }, { onSuccess: () => setEmail('') })
      }}>
        <label className="grid gap-1 text-sm">User’s email
          <input className="admin-input" type="email" required value={email}
            placeholder="Someone in your organisation" onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button className="admin-button admin-button-primary" type="submit" disabled={change.isPending}>Add viewer</button>
      </form>
      <FormError>{change.isError
        ? formErrorMessage(change.error, 'Could not update sharing. Use an active Nessie user in your organisation.')
        : null}</FormError>
      <QueryState query={query} loadingLabel="Loading viewers…" errorLabel="Could not load viewers.">
        {() => query.data?.length ? <ul className="grid gap-3" aria-label="Session viewers">
          {query.data.map((person) => <li key={person.userId} className="flex items-center justify-between gap-3">
            <span className="min-w-0 break-words text-sm">{person.displayName || person.email}
              {person.displayName ? <span className="block text-xs text-[color:var(--tx3)]">{person.email}</span> : null}
            </span>
            <button className="admin-button admin-button-secondary admin-button-compact" type="button"
              disabled={change.isPending} onClick={() => change.mutate({ userId: person.userId })}>Remove</button>
          </li>)}
        </ul> : <p className="text-sm text-[color:var(--tx2)]">Only you can view this session.</p>}
      </QueryState>
      <p className="text-xs text-[color:var(--tx3)]">Viewers can find it in Computers → Sessions, or open this page’s link.</p>
    </div>
  </Dialog>
}
