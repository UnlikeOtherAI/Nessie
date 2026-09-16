import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { KnowledgeRoot } from '@nessie/schemas'
import {
  useInvalidateTransferReach,
  useTransferPages,
  useTransferStatus,
  type TransferPagesInput,
} from '../../../../facades/knowledge/finder-hooks'
import type { KnowledgePageRecord } from '../../../../facades/knowledge/hooks'
import { useToasts } from '../../../../providers/ToastProvider'
import type { ContextMenuAnchor } from '../../../overlays/useContextMenu'
import { TransferPrompt, type TransferRefusal } from './TransferPrompt'
import { TransferProgressRow } from './TransferProgressRow'
import {
  destinationsFromRoot,
  transferProgressSentence,
  type TransferDestination,
} from './transfer-copy'
import type { FinderDragPayload, FinderDropTarget } from './useFinderDrag'

/**
 * The whole move-or-copy path, as one thing a Finder can mount (transfer.md).
 *
 * `onForeignDrop` is what `useFinderDrag` calls when a drag crosses root
 * folders; `prompt` is the menu that asks, and `progressRows` are the tray rows
 * for the transfers that became jobs. It is a hook rather than a component
 * because all three share one piece of state — the drop that is being decided —
 * and because the drag has to reach it before anything is rendered.
 *
 * Nothing is sent until the person chooses. ⌥ at release is the one exception
 * and it is Finder's own: it means copy, it skips the menu, and the `+` beside
 * the pointer said so before the button came up.
 */

export type UseFinderTransfersInput = {
  /** The root column's payload: the target names, audiences and write rights. */
  root: KnowledgeRoot | undefined
  /** The source column's rows, for the item name and the share count. */
  pageById: (pageId: string) => KnowledgePageRecord | undefined
}

export type UseFinderTransfers = {
  onForeignDrop: (
    payload: FinderDragPayload,
    target: FinderDropTarget,
    point: { x: number; y: number },
    altKey: boolean,
  ) => void
  prompt: ReactNode
  progressRows: ReactNode
}

type PendingDrop = {
  anchor: ContextMenuAnchor
  destination: TransferDestination
  input: Omit<TransferPagesInput, 'operation'>
  count: number
  title?: string
  sharesEnding: number
  canMove: boolean
  sourceName: string
}

type ActiveTransfer = {
  transferId: string
  operation: 'move' | 'copy'
  input: Omit<TransferPagesInput, 'operation'>
  count: number
  destination: TransferDestination
  sourceName: string
}

export const useFinderTransfers = ({
  pageById,
  root,
}: UseFinderTransfersInput): UseFinderTransfers => {
  const transferPages = useTransferPages()
  const invalidateReach = useInvalidateTransferReach()
  const { pushToast } = useToasts()

  const [pending, setPending] = useState<PendingDrop | null>(null)
  const [refusal, setRefusal] = useState<TransferRefusal | null>(null)
  const [jobs, setJobs] = useState<ActiveTransfer[]>([])
  // The menu's focus return. The dragged row is gone from the DOM by the time a
  // transfer lands, so `ContextMenu` falls back to the document; the ref is the
  // element the pointer was over at release, which is the drop target itself.
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const destinations = useMemo(() => destinationsFromRoot(root), [root])
  const spaceNamed = useCallback(
    (spaceId: string): string =>
      destinations.find((space) => space.spaceId === spaceId)?.name ?? 'that folder',
    [destinations],
  )

  const send = useCallback(
    (
      operation: 'move' | 'copy',
      drop: Pick<PendingDrop, 'count' | 'destination' | 'input' | 'sourceName'>,
    ) => {
      setRefusal(null)
      transferPages.mutate(
        { ...drop.input, operation },
        {
          onError: (error) => {
            const detail = error as { code?: string; message?: string }
            // The refusal takes the menu's place rather than a toast: the
            // person is still looking at the point they dropped on, and the
            // sentence is about that drop.
            setRefusal({ code: detail.code, message: detail.message })
            setPending((current) => current ?? {
              anchor: { kind: 'point', x: 0, y: 0 },
              canMove: true,
              count: drop.count,
              destination: drop.destination,
              input: drop.input,
              sharesEnding: 0,
              sourceName: drop.sourceName,
            })
          },
          onSuccess: (result) => {
            setPending(null)
            if (result.status === 'queued') {
              setJobs((current) => [
                ...current.filter((job) => job.transferId !== result.transferId),
                {
                  count: drop.count,
                  destination: drop.destination,
                  input: drop.input,
                  operation,
                  sourceName: drop.sourceName,
                  transferId: result.transferId,
                },
              ])
              return
            }
            const moved = result.pages.length + result.descendants
            pushToast({
              // The shares the move ended, said after the fact as well as
              // before it: the prompt's warning is a prediction, this is the
              // count the server actually deleted.
              body: result.sharesEnded > 0
                ? `Sharing with ${result.sharesEnded} `
                  + `${result.sharesEnded === 1 ? 'person' : 'people'} ended.`
                : `${drop.count === 1 ? 'It is' : 'They are'} in ${drop.destination.name} now.`,
              title: transferProgressSentence({
                count: drop.count,
                destinationName: drop.destination.name,
                done: moved,
                error: null,
                operation,
                sourceName: drop.sourceName,
                status: 'done',
                total: moved,
              }),
            })
          },
        },
      )
    },
    [pushToast, transferPages],
  )

  const onForeignDrop = useCallback<UseFinderTransfers['onForeignDrop']>(
    (payload, target, point, altKey) => {
      const destination = destinations.find((space) => space.spaceId === target.spaceId)
      // A target the root column has never described is one this surface cannot
      // name an audience for, and an unnamed audience is the one thing
      // `acknowledged: true` may not claim.
      if (!destination) return
      const rows = payload.pageIds.map((id) => pageById(id))
      const sourceSpace = destinations.find((space) => space.spaceId === payload.spaceId)
      const drop: PendingDrop = {
        anchor: { kind: 'point', x: point.x, y: point.y },
        // A grantee may copy out of a folder they only read; they may not
        // remove anything from it.
        canMove: sourceSpace?.canWrite ?? true,
        count: payload.pageIds.length,
        destination,
        input: {
          pageIds: [...payload.pageIds],
          sourceSpaceId: payload.spaceId,
          target: { parentPageId: target.parentPageId, spaceId: target.spaceId },
        },
        sharesEnding: rows.reduce((total, row) => total + (row?.shareCount ?? 0), 0),
        sourceName: sourceSpace?.name ?? spaceNamed(payload.spaceId),
        title: rows.length === 1 ? rows[0]?.title : undefined,
      }
      setRefusal(null)
      if (altKey) {
        setPending(null)
        send('copy', drop)
        return
      }
      setPending(drop)
    },
    [destinations, pageById, send, spaceNamed],
  )

  const close = useCallback(() => {
    setPending(null)
    setRefusal(null)
  }, [])

  const dismissJob = useCallback((transferId: string) => {
    setJobs((current) => current.filter((job) => job.transferId !== transferId))
  }, [])

  const prompt = pending ? (
    <TransferPrompt
      anchor={pending.anchor}
      canMove={pending.canMove}
      count={pending.count}
      destination={pending.destination}
      moveDisabledReason={`You can't remove items from ${pending.sourceName}`}
      onChoose={(operation) => send(operation, pending)}
      onClose={close}
      refusal={refusal}
      returnFocusRef={returnFocusRef}
      sharesEnding={pending.sharesEnding}
      title={pending.title}
    />
  ) : null

  const progressRows = jobs.map((job) => (
    <TransferJobRow
      job={job}
      key={job.transferId}
      onDismiss={() => dismissJob(job.transferId)}
      onFinished={() => invalidateReach({ ...job.input, operation: job.operation })}
      onRetry={() => {
        dismissJob(job.transferId)
        // An ordinary new transfer over what is left, which is what the worker's
        // partial-move contract asks for. It goes through every refusal again,
        // and a root that already landed in the target is one of them — the
        // sentence the server answers with is shown, not swallowed.
        send(job.operation, {
          count: job.count,
          destination: job.destination,
          input: job.input,
          sourceName: job.sourceName,
        })
      }}
    />
  ))

  return { onForeignDrop, progressRows, prompt }
}

/**
 * One job's tray row. A component rather than a loop body because the poll is a
 * hook, and because a finished transfer has to invalidate both ends exactly
 * once — the effect that does it belongs to the row that saw it finish.
 */
const TransferJobRow = ({
  job,
  onDismiss,
  onFinished,
  onRetry,
}: {
  job: ActiveTransfer
  onDismiss: () => void
  onFinished: () => void
  onRetry: () => void
}) => {
  const status = useTransferStatus(job.transferId)
  const state = status.data?.status ?? 'queued'
  // `onFinished` is rebuilt on every render of the host, so the effect is keyed
  // on the state it reacts to and reads the callback through a ref. A React
  // Query callback in a dependency array is the shape that re-runs an effect
  // every render.
  const finish = useRef(onFinished)
  finish.current = onFinished
  useEffect(() => {
    if (state === 'done' || state === 'failed') finish.current()
  }, [state])

  return (
    <TransferProgressRow
      onDismiss={onDismiss}
      onRetry={state === 'done' ? undefined : onRetry}
      progress={{
        count: job.count,
        destinationName: job.destination.name,
        done: status.data?.done ?? 0,
        error: status.data?.error ?? null,
        operation: status.data?.operation ?? job.operation,
        sourceName: job.sourceName,
        status: state,
        total: status.data?.total ?? 0,
      }}
    />
  )
}
