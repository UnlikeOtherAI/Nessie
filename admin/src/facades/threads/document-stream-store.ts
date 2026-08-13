// The *read* side of live document composition: how a component subscribes to
// the text of one session and how often it is allowed to re-render for it.
//
// Kept apart from `document-stream.ts`, which folds the wire frames into the
// store, because the two answer different questions and only meet at this one
// interface. The separation is what lets a surface with no document facade at
// all (the read-only info drawers) hold a real store object.

import { useEffect, useState } from 'react'
import type { DocumentStreamEntry } from './document-stream-helpers'

export type DocumentStreamStore = {
  read: (sessionId: string) => DocumentStreamEntry | undefined
  subscribe: (sessionId: string, listener: () => void) => () => void
}

const scheduleFrame = (callback: () => void): (() => void) => {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 0)
    return () => clearTimeout(timer)
  }
  const handle = requestAnimationFrame(callback)
  return () => cancelAnimationFrame(handle)
}

/**
 * The live view of one session, committed at most once per animation frame.
 * Arrival is never delayed by rendering — the store already holds every byte —
 * and a component that paints the document re-renders once per frame instead of
 * once per provider chunk.
 */
export const useDocumentStreamSnapshot = (
  store: DocumentStreamStore,
  entry: DocumentStreamEntry,
): DocumentStreamEntry => {
  const [snapshot, setSnapshot] = useState<DocumentStreamEntry>(
    () => store.read(entry.sessionId) ?? entry,
  )

  useEffect(() => {
    let cancelFrame: (() => void) | null = null
    const commit = () => {
      cancelFrame = null
      setSnapshot(store.read(entry.sessionId) ?? entry)
    }
    const schedule = () => {
      if (cancelFrame) {
        return
      }
      cancelFrame = scheduleFrame(commit)
    }

    schedule()
    const unsubscribe = store.subscribe(entry.sessionId, schedule)
    return () => {
      cancelFrame?.()
      cancelFrame = null
      unsubscribe()
    }
  }, [entry, store])

  return snapshot
}

// A thread with no document facade (the info drawers render read-only feeds).
export const emptyDocumentStore: DocumentStreamStore = {
  read: () => undefined,
  subscribe: () => () => undefined,
}
