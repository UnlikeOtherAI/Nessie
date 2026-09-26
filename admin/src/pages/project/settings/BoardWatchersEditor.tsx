import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('projects')
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
          setError(cause instanceof Error ? cause.message : t('boardSettings.watchersSaveError')),
      },
    )
  }

  return (
    <Section
      description={
        t('boardSettings.watchersDescription', { boardName })
      }
      title={t('boardSettings.watchers')}
    >
      <QueryState
        errorLabel={t('boardSettings.watchersLoadError')}
        loadingLabel={t('boardSettings.watchersLoading')}
        query={watchersQuery}
      >
        {() => (
          <div className="grid gap-3">
            <RecipientBar
              agents={NO_AGENTS}
              closeAfterSelection
              disabled={setWatchers.isPending}
              label={t('boardSettings.watchersTell')}
              onChange={setRecipients}
              placeholder={t('boardSettings.watchersPlaceholder')}
              recipients={recipients}
              token={token}
              users={users}
            />
            <p className="text-xs text-[color:var(--tx3)]" data-testid="watchers-agents-moved">
              {t('boardSettings.watchersAgentHint')}
            </p>
            <FormError>{error ?? undefined}</FormError>
            {dirty ? (
              <div className="flex justify-end gap-2">
                <button className="admin-button" onClick={() => setRecipients(saved)} type="button">
                  {t('common.cancel')}
                </button>
                <button
                  className="admin-button admin-button-primary"
                  disabled={setWatchers.isPending}
                  onClick={save}
                  type="button"
                >
                  {setWatchers.isPending ? t('boardSettings.watchersSaving') : t('boardSettings.watchersSave')}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </QueryState>
    </Section>
  )
}
