import { useEffect, useMemo, useState } from 'react'
import {
  useBoardWatchers,
  useSetBoardWatchers,
} from '../../../facades/boards/hooks'
import { useUsers } from '../../../facades/users/hooks'
import { type Recipient } from '../../../lib/channel-compose-recipients'
import { FormError } from '../../../components/shared/FormActions'
import { QueryState } from '../../../components/shared/QueryState'
import { RecipientBar } from '../../../components/shared/RecipientBar'
import { Section } from '../../../components/shared/PageBody'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

type BoardWatchersEditorProps = {
  projectId: string
  boardId: string
  boardName: string
}

// Watchers are people. An agent is woken by a ticket trigger, set up from the
// board's column menu (docs/plans/2026-09-06-board-watchers.md §11), so the
// address bar offers no agent and says where they went.
const NO_AGENTS: never[] = []

/**
 * Who hears that a connected ticket changed remotely.
 *
 * The same address bar as New message, on purpose: choosing a person is one
 * act in this product. Saving replaces the list, because a watcher list is
 * short and read as a document — a diff would be two orderings of one edit.
 */
export const BoardWatchersEditor = ({
  projectId,
  boardId,
  boardName,
}: BoardWatchersEditorProps) => {
  const { token } = useAuthSession()
  const { data: users = [] } = useUsers()
  const watchersQuery = useBoardWatchers(projectId, boardId)
  const setWatchers = useSetBoardWatchers(projectId, boardId)
  const [error, setError] = useState<string | null>(null)

  const saved = useMemo<Recipient[]>(
    () =>
      (watchersQuery.data ?? [])
        .filter((watcher) => watcher.kind === 'user')
        .map((watcher) => ({ id: watcher.recipientId, kind: 'user' as const })),
    [watchersQuery.data],
  )

  const [recipients, setRecipients] = useState<Recipient[]>(saved)
  // The server's answer is the truth; a refetch or another editor's save
  // replaces what is on screen rather than being silently overwritten by it.
  useEffect(() => setRecipients(saved), [saved])

  const dirty =
    recipients.length !== saved.length ||
    recipients.some(
      (recipient) =>
        !saved.some((item) => item.id === recipient.id && item.kind === recipient.kind),
    )

  const save = () => {
    setError(null)
    setWatchers.mutate(
      recipients.map((recipient) => ({ kind: recipient.kind, id: recipient.id })),
      {
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not save the watchers'),
      },
    )
  }

  return (
    <Section
      description={
        `Alert people when a connected ticket moves or is reassigned remotely ` +
        `after its first import on ${boardName}. Native tickets and local moves ` +
        'do not notify watchers.'
      }
      title="Watchers"
    >
      <QueryState
        errorLabel="Couldn't load watchers."
        loadingLabel="Loading watchers…"
        query={watchersQuery}
      >
        {() => (
          <div className="grid gap-3">
            <RecipientBar
              agents={NO_AGENTS}
              closeAfterSelection
              disabled={setWatchers.isPending}
              label="Tell"
              onChange={setRecipients}
              placeholder="Type a name"
              recipients={recipients}
              token={token}
              users={users}
            />
            <p className="text-xs text-[color:var(--tx3)]" data-testid="watchers-agents-moved">
              Agents start work from the column menu: “Start work with an agent…” on a board column.
            </p>
            <FormError>{error ?? undefined}</FormError>
            {dirty ? (
              <div className="flex justify-end gap-2">
                <button className="admin-button" onClick={() => setRecipients(saved)} type="button">
                  Cancel
                </button>
                <button
                  className="admin-button admin-button-primary"
                  disabled={setWatchers.isPending}
                  onClick={save}
                  type="button"
                >
                  {setWatchers.isPending ? 'Saving…' : 'Save watchers'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
    </Section>
  )
}
