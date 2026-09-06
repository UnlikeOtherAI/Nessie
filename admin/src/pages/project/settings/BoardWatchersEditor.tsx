import { useEffect, useMemo, useState } from 'react'
import {
  useBoardWatchers,
  useSetBoardWatchers,
} from '../../../facades/boards/hooks'
import { useAgents } from '../../../facades/agents/hooks'
import { useUsers } from '../../../facades/users/hooks'
import { selectAddressableAgents, type Recipient } from '../../../lib/channel-compose-recipients'
import { FormError } from '../../../components/shared/FormActions'
import { useIsOwner } from '../../../facades/auth/hooks'
import { RecipientBar } from '../../../components/shared/RecipientBar'
import { Section } from '../../../components/shared/PageBody'
import { useAuthSession } from '../../../providers/AuthSessionProvider'

type BoardWatchersEditorProps = {
  projectId: string
  boardId: string
  boardName: string
}

/**
 * Who hears that a ticket on this board moved.
 *
 * The same address bar as New message, on purpose: choosing a person or an
 * agent is one act in this product, even though what happens next differs.
 * Saving replaces the list, because a watcher list is short and read as a
 * document — a diff would be two orderings of one edit.
 */
export const BoardWatchersEditor = ({
  projectId,
  boardId,
  boardName,
}: BoardWatchersEditorProps) => {
  const { token } = useAuthSession()
  const isOwner = useIsOwner()
  const { data: users = [] } = useUsers(isOwner)
  const { data: allAgents = [] } = useAgents({ scope: 'all' })
  const watchersQuery = useBoardWatchers(projectId, boardId)
  const setWatchers = useSetBoardWatchers(projectId, boardId)
  const [error, setError] = useState<string | null>(null)

  const agents = useMemo(
    () => selectAddressableAgents(allAgents, { isOwner }),
    [allAgents, isOwner],
  )

  const saved = useMemo<Recipient[]>(
    () =>
      (watchersQuery.data ?? []).map((watcher) => ({
        id: watcher.recipientId,
        kind: watcher.kind,
      })),
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
      description={`They hear about every ticket that moves or changes on ${boardName}. Nobody is told about a first import.`}
      title="Watchers"
    >
      <div className="grid gap-3">
        <RecipientBar
          agents={agents}
          disabled={setWatchers.isPending}
          label="Tell"
          onChange={setRecipients}
          placeholder="Type a name or an agent"
          recipients={recipients}
          token={token}
          users={users}
        />
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
    </Section>
  )
}
