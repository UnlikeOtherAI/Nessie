import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Drafts — auto-save first, never a save button, never a confirm
 * (docs/navigation/overview.md → "Drafts", plan §4.11).
 *
 * One primitive behind every composer, editor and dialog that holds a person's
 * unsent words. It buffers to `localStorage` on a short debounce and, where an
 * endpoint exists, flushes to the server on a longer one. Leaving a screen is
 * therefore safe by construction: the draft is already persisted, so nothing
 * has to ask "discard changes?".
 *
 * The key is the entity (`draft:<surface>:<entityId>`), which is what stops a
 * channel composer's text and staged attachments leaking into the next channel.
 */

export const DRAFT_KEY_PREFIX = 'draft'

/** `draft:<surface>:<entityId>`; null entity = nothing to key on, so no store. */
export const draftKey = (
  surface: string,
  entityId: string | null | undefined,
): string | null => (entityId ? `${DRAFT_KEY_PREFIX}:${surface}:${entityId}` : null)

const DEFAULT_LOCAL_DEBOUNCE_MS = 300
const DEFAULT_SERVER_DEBOUNCE_MS = 2000

export type DraftLocalOptions = {
  debounceMs?: number
}

export type DraftServerOptions<T> = {
  debounceMs?: number
  save: (draft: T) => Promise<void>
}

export type UseDraftOptions<T> = {
  initial: T
  local?: DraftLocalOptions
  server?: DraftServerOptions<T>
  /**
   * A draft equal to nothing is not worth storing — an empty composer must not
   * leave a row behind that a later mount would "restore". Defaults to a
   * signature comparison against `initial`.
   */
  isEmpty?: (draft: T) => boolean
  /** Runs on the value read back from storage; drop anything untrustworthy. */
  revive?: (stored: unknown) => T | null
}

export type UseDraftResult<T> = {
  draft: T
  setDraft: (next: T | ((current: T) => T)) => void
  /** Write the buffer now and, when a server lane exists, send it now. */
  flush: () => Promise<void>
  /** A successful send/save: forget the stored draft and go back to `initial`. */
  clear: () => void
  /** True when this mount hydrated from a stored draft rather than `initial`. */
  restored: boolean
  /**
   * Bumps only when the hook itself replaced the value — a key swap, a restore
   * from storage, or `clear()` — never on a keystroke. An uncontrolled editor
   * (a contenteditable composer) syncs itself off this, so typing never
   * re-renders its own text back into it.
   */
  revision: number
  /** The server's own words for a rejected payload; never a blocking dialog. */
  saveError: string | null
  isSaving: boolean
}

const signatureOf = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    // A draft that cannot be serialized cannot be stored either; a stable
    // sentinel keeps the diff honest instead of throwing on every keystroke.
    return '__unserializable__'
  }
}

// Private mode, a full quota and a browser with site data blocked all throw
// here rather than returning null, so every access is guarded.
const readStored = (key: string): unknown => {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

const writeStored = (key: string, value: unknown): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Nothing to do: the draft still lives in memory for this mount.
  }
}

const removeStored = (key: string): void => {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Same as above — a store we cannot write is a store we cannot clear.
  }
}

export const useDraft = <T,>(
  key: string | null,
  options: UseDraftOptions<T>,
): UseDraftResult<T> => {
  const { initial } = options

  const optionsRef = useRef(options)
  optionsRef.current = options

  const emptySignature = signatureOf(initial)
  const emptySignatureRef = useRef(emptySignature)
  emptySignatureRef.current = emptySignature

  const draftRef = useRef<T>(initial)
  const keyRef = useRef<string | null>(key)
  // Signature of the last value written to localStorage under `keyRef`.
  const storedSignatureRef = useRef<string>(emptySignature)
  // Signature of the last value the server accepted.
  const savedSignatureRef = useRef<string>(emptySignature)
  // Signature the server rejected: the autosave lane never retries it, so a
  // validation error cannot turn into a request loop. An explicit flush does.
  const rejectedSignatureRef = useRef<string | null>(null)
  const localTimerRef = useRef<number | null>(null)
  const serverTimerRef = useRef<number | null>(null)
  const savingRef = useRef(false)

  const [draft, setDraftState] = useState<T>(initial)
  const [restored, setRestored] = useState(false)
  const [revision, setRevision] = useState(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  const isDraftEmpty = useCallback(
    (value: T): boolean =>
      optionsRef.current.isEmpty
        ? optionsRef.current.isEmpty(value)
        : signatureOf(value) === emptySignatureRef.current,
    [],
  )

  const cancelLocalTimer = () => {
    if (localTimerRef.current !== null) {
      window.clearTimeout(localTimerRef.current)
      localTimerRef.current = null
    }
  }

  const cancelServerTimer = () => {
    if (serverTimerRef.current !== null) {
      window.clearTimeout(serverTimerRef.current)
      serverTimerRef.current = null
    }
  }

  // Writes the buffer under whichever key it belongs to. Signature-diffed, so
  // a re-render that changes nothing never touches storage.
  const persistLocal = useCallback((targetKey: string | null, value: T) => {
    if (!targetKey) {
      return
    }
    const signature = signatureOf(value)
    if (signature === storedSignatureRef.current) {
      return
    }
    storedSignatureRef.current = signature
    if (isDraftEmpty(value)) {
      removeStored(targetKey)
      return
    }
    writeStored(targetKey, value)
  }, [isDraftEmpty])

  const sendToServer = useCallback(
    async (value: T, mode: 'auto' | 'flush'): Promise<void> => {
      const serverLane = optionsRef.current.server
      if (!serverLane || savingRef.current) {
        return
      }
      const signature = signatureOf(value)
      if (signature === savedSignatureRef.current) {
        return
      }
      if (mode === 'auto' && signature === rejectedSignatureRef.current) {
        return
      }
      savingRef.current = true
      setIsSaving(true)
      try {
        await serverLane.save(value)
        savedSignatureRef.current = signature
        rejectedSignatureRef.current = null
        setSaveError(null)
      } catch (error) {
        rejectedSignatureRef.current = signature
        setSaveError(
          error instanceof Error && error.message
            ? error.message
            : 'This could not be saved. Your draft is kept.',
        )
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    },
    [],
  )

  // Key change (a different channel, task, page): the outgoing draft is
  // written under its OWN key synchronously before the new one is read, which
  // is exactly what stops one surface's text arriving in the next.
  useEffect(() => {
    if (keyRef.current === key) {
      return
    }
    cancelLocalTimer()
    cancelServerTimer()
    persistLocal(keyRef.current, draftRef.current)
    keyRef.current = key

    const stored = key ? readStored(key) : null
    const reviver = optionsRef.current.revive
    const hydrated = stored === null
      ? null
      : reviver
        ? reviver(stored)
        : (stored as T)
    if (stored !== null && hydrated === null && key) {
      removeStored(key)
    }
    const next = hydrated ?? optionsRef.current.initial
    draftRef.current = next
    storedSignatureRef.current = signatureOf(next)
    savedSignatureRef.current = signatureOf(next)
    rejectedSignatureRef.current = null
    setDraftState(next)
    setRestored(hydrated !== null)
    setRevision((current) => current + 1)
    setSaveError(null)
  }, [key, persistLocal])

  // First mount: restore a present draft.
  useEffect(() => {
    if (!key) {
      return
    }
    const stored = readStored(key)
    if (stored === null) {
      return
    }
    const reviver = optionsRef.current.revive
    const hydrated = reviver ? reviver(stored) : (stored as T)
    if (hydrated === null) {
      removeStored(key)
      return
    }
    // A draft edited before this effect ran wins over the stored one.
    if (!isDraftEmpty(draftRef.current)) {
      return
    }
    draftRef.current = hydrated
    storedSignatureRef.current = signatureOf(hydrated)
    savedSignatureRef.current = signatureOf(hydrated)
    setDraftState(hydrated)
    setRestored(true)
    setRevision((current) => current + 1)
    // Mount-only: the key-change effect above owns every later switch.
  }, [])

  const scheduleLanes = useCallback(
    () => {
      const localDelay = optionsRef.current.local?.debounceMs ?? DEFAULT_LOCAL_DEBOUNCE_MS
      cancelLocalTimer()
      localTimerRef.current = window.setTimeout(() => {
        localTimerRef.current = null
        persistLocal(keyRef.current, draftRef.current)
      }, localDelay)

      if (!optionsRef.current.server) {
        return
      }
      const serverDelay =
        optionsRef.current.server.debounceMs ?? DEFAULT_SERVER_DEBOUNCE_MS
      cancelServerTimer()
      serverTimerRef.current = window.setTimeout(() => {
        serverTimerRef.current = null
        void sendToServer(draftRef.current, 'auto')
      }, serverDelay)
    },
    [persistLocal, sendToServer],
  )

  const setDraft = useCallback(
    (next: T | ((current: T) => T)) => {
      const resolved =
        typeof next === 'function'
          ? (next as (current: T) => T)(draftRef.current)
          : next
      draftRef.current = resolved
      setDraftState(resolved)
      scheduleLanes()
    },
    [scheduleLanes],
  )

  const flush = useCallback(async () => {
    cancelLocalTimer()
    cancelServerTimer()
    persistLocal(keyRef.current, draftRef.current)
    await sendToServer(draftRef.current, 'flush')
  }, [persistLocal, sendToServer])

  const clear = useCallback(() => {
    cancelLocalTimer()
    cancelServerTimer()
    if (keyRef.current) {
      removeStored(keyRef.current)
    }
    const next = optionsRef.current.initial
    draftRef.current = next
    storedSignatureRef.current = signatureOf(next)
    savedSignatureRef.current = signatureOf(next)
    rejectedSignatureRef.current = null
    setDraftState(next)
    setRestored(false)
    setRevision((current) => current + 1)
    setSaveError(null)
  }, [])

  // Unmount (the thread panel closing, a dialog dismissed) still persists: the
  // buffer would otherwise be lost inside the debounce window.
  useEffect(
    () => () => {
      cancelLocalTimer()
      cancelServerTimer()
      persistLocal(keyRef.current, draftRef.current)
    },
    [persistLocal],
  )

  return { clear, draft, flush, isSaving, restored, revision, saveError, setDraft }
}
