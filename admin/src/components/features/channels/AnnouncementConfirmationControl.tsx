import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '../../../providers/ApiClientProvider'

type OwnReceipt = { eligible: boolean; seen: boolean; acknowledged: boolean }
type Person = { id: string; displayName: string; seenAt: string | null;
  acknowledgedAt: string | null; reminderSent: boolean;
  reminderPending: boolean; reminderError: string | null }
type ConfirmationStatus = { canRemind: boolean; acknowledged: Person[];
  seen: Person[]; unseen: Person[] }

export const AnnouncementConfirmationControl = ({
  messageId, isAuthor, canViewStatus,
}: { messageId: string; isAuthor: boolean; canViewStatus: boolean }) => {
  const api = useApiClient()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const controlRef = useRef<HTMLDivElement>(null)
  const seenSent = useRef(false)
  const ownKey = ['announcement-confirmation', messageId, 'own'] as const
  const statusKey = ['announcement-confirmation', messageId, 'status'] as const
  const own = useQuery({
    queryKey: ownKey,
    queryFn: () => api.get<OwnReceipt>(`/api/messages/${messageId}/confirmation`),
    enabled: !isAuthor,
  })
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => api.get<ConfirmationStatus>(`/api/messages/${messageId}/confirmation-status`),
    enabled: canViewStatus && open,
    refetchInterval: open ? 10_000 : false,
  })
  const seen = useMutation({
    mutationFn: () => api.post(`/api/messages/${messageId}/seen`, {}),
    onSuccess: () => queryClient.setQueryData<OwnReceipt>(ownKey, (current) =>
      current ? { ...current, seen: true } : current),
    onError: () => { seenSent.current = false },
  })
  const markSeen = seen.mutate
  const acknowledge = useMutation({
    mutationFn: () => api.post(`/api/messages/${messageId}/acknowledge`, {}),
    onSuccess: () => queryClient.setQueryData<OwnReceipt>(ownKey, (current) =>
      current ? { ...current, seen: true, acknowledged: true } : current),
  })
  const remind = useMutation({
    mutationFn: () => api.post<{ queued: number }>(`/api/messages/${messageId}/remind-unconfirmed`, {}),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: statusKey }),
  })
  const outstanding = status.data ? [...status.data.seen, ...status.data.unseen] : []
  const remindedCount = outstanding.filter((person) => person.reminderSent).length
  const failedCount = outstanding.filter((person) => person.reminderError && !person.reminderSent).length
  const canRequestReminder = outstanding.some((person) =>
    !person.reminderSent && !person.reminderPending)

  useEffect(() => {
    seenSent.current = false
  }, [messageId])
  useEffect(() => {
    if (isAuthor || !own.data?.eligible || own.data.seen || seenSent.current) return
    const element = controlRef.current
    if (!element) return
    let intersecting = false
    const reportVisible = () => {
      if (!intersecting || document.visibilityState !== 'visible' || seenSent.current) return
      seenSent.current = true
      markSeen()
    }
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.5)
      reportVisible()
    }, { threshold: 0.5 })
    observer.observe(element)
    document.addEventListener('visibilitychange', reportVisible)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', reportVisible)
    }
  }, [isAuthor, markSeen, own.data?.eligible, own.data?.seen, messageId])

  return <div className="mt-2 grid gap-2 text-xs" ref={controlRef}>
    {canViewStatus ? <div>
      <button aria-expanded={open} className="admin-button admin-button-secondary"
        onClick={() => setOpen((value) => !value)} type="button">
        {open ? 'Hide confirmations' : 'View confirmations'}
      </button>
      {open ? (
        <div className="admin-card mt-2 grid gap-3 p-3" role="region" aria-label="Confirmation status">
          {status.isLoading ? <p>Loading confirmation status…</p> : null}
          {status.isError ? <p role="alert">Confirmation status is unavailable.</p> : null}
          {status.data ? (
            <>
              {([
                ['Acknowledged', status.data.acknowledged],
                ['Seen, awaiting confirmation', status.data.seen],
                ['Not seen', status.data.unseen],
              ] as const).map(([label, people]) => (
                <section key={label}>
                  <h4 className="font-semibold">{label} ({people.length})</h4>
                  {people.length ? <ul className="list-disc pl-5">
                    {people.map((person) => <li key={person.id}>
                      {person.displayName}{person.reminderSent ? ' · reminded' : ''}
                      {person.reminderError ? ` · ${person.reminderError}` : ''}
                    </li>)}
                  </ul> : <p className="text-[color:var(--tx3)]">Nobody</p>}
                </section>
              ))}
              <p className="text-[color:var(--tx3)]">
                Reminders: {remindedCount} sent, {failedCount} failed,
                {' '}{outstanding.length - remindedCount - failedCount} pending or not requested.
              </p>
              {status.data.canRemind && canRequestReminder ? (
                <button className="admin-button admin-button-primary justify-self-start"
                  disabled={remind.isPending} onClick={() => remind.mutate()} type="button">
                  {remind.isPending ? 'Queueing reminders…' : 'Remind unconfirmed'}
                </button>
              ) : null}
              {remind.isSuccess ? <p role="status">{remind.data.queued > 0
                ? 'Reminders queued for eligible people.' : 'No new reminders were needed.'}</p> : null}
              {remind.isError ? <p role="alert">Reminders could not be queued. Try again.</p> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div> : null}
    {!isAuthor && own.data?.eligible ? <div className="flex flex-wrap items-center gap-2">
    <button className="admin-button admin-button-primary" type="button"
      disabled={own.data.acknowledged || acknowledge.isPending}
      onClick={() => acknowledge.mutate()}>
      {own.data.acknowledged ? 'Acknowledged' : 'Acknowledge'}
    </button>
    <span className="text-[color:var(--tx3)]">Opening this post reports that you have seen it.</span>
    {seen.isError && !own.data.seen
      ? <span role="alert">Could not report this post as seen. Reopen it to retry.</span> : null}
    {acknowledge.isError ? <span role="alert">Could not acknowledge. Try again.</span> : null}
    </div> : null}
  </div>
}
