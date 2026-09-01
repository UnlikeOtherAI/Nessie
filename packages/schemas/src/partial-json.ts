/**
 * Incremental extraction of tool-call arguments that are still being written.
 *
 * A model emits a document as the arguments of a tool call, and the provider
 * streams those arguments as raw JSON fragments. To show the document as it
 * arrives we must decode it *before* the JSON is parseable — but a viewer
 * watching one document while a different one is saved would be worse than no
 * streaming at all, so these are real lexer-backed readers with two hard
 * invariants rather than regexes over half-written text:
 *
 * - **Committed-prefix monotonicity.** Output only ever grows by appending. A
 *   half-arrived escape (`\`, three of four `\uXXXX` digits) or a lone high
 *   surrogate is withheld until it completes — raw text and escapes alike,
 *   since a chunk boundary splits a literal emoji just as easily as an escape.
 * - **Duplicate-key rejection.** `JSON.parse` keeps the *last* of duplicated
 *   keys, so a second `markdown` key could make the saved document differ from
 *   the streamed one. That fails the scan instead.
 *
 * Both readers are fed fragments in order and are O(new characters).
 */

import {
  committedPrefix,
  createJsonLexer,
  type JsonPath,
} from './partial-json-lexer.js'

/** Completed scalar fields are kept for cheap metadata reads. */
const MAX_TRACKED_FIELD_LENGTH = 4_096

export type PartialJsonScanner = {
  /** Feed the next raw JSON fragment. Ignored once the scan has failed. */
  push: (fragment: string) => void
  /**
   * Decoded value of the target field so far, guaranteed to be a prefix of the
   * final value (never ends mid-escape or on a lone high surrogate).
   */
  committed: () => string
  /** Completed top-level string fields other than the target. */
  fields: () => Record<string, string>
  /** True once the target field's string value has been closed. */
  isComplete: () => boolean
  /** Non-null when the fragment stream is unusable; scanning has stopped. */
  error: () => string | null
}

const isTopLevelKey = (path: JsonPath, key: string): boolean =>
  path.length === 1 && path[0] === key

/**
 * Reads one top-level string field as it streams (the composed document body),
 * while collecting the other top-level scalars whole so a caller can show the
 * title and destination before the body has finished.
 */
export const createPartialJsonScanner = (targetKey: string): PartialJsonScanner => {
  const completedFields: Record<string, string> = {}

  let raw = ''
  let failure: string | null = null
  let complete = false
  let seenTarget = false

  // Non-target top-level scalars are accumulated whole rather than streamed.
  let trackedKey: string | null = null
  let trackedValue = ''

  const lexer = createJsonLexer({
    appendText: (text) => {
      if (trackedKey !== null) {
        if (trackedValue.length < MAX_TRACKED_FIELD_LENGTH) trackedValue += text
        return
      }
      raw += text
    },
    beginValue: (path) => {
      if (isTopLevelKey(path, targetKey)) {
        if (seenTarget) {
          failure = `Duplicate top-level "${targetKey}" key in tool arguments`
          return 'ignore'
        }
        seenTarget = true
        trackedKey = null
        return 'capture'
      }
      if (path.length === 1 && typeof path[0] === 'string') {
        trackedKey = path[0]
        trackedValue = ''
        return 'capture'
      }
      return 'ignore'
    },
    endValue: () => {
      if (trackedKey !== null) {
        completedFields[trackedKey] = trackedValue
        trackedKey = null
        trackedValue = ''
        return
      }
      complete = true
    },
    fail: (message) => {
      failure ??= message
    },
  })

  return {
    committed: () => committedPrefix(raw),
    error: () => failure,
    fields: () => ({ ...completedFields }),
    isComplete: () => complete,
    push: (fragment) => {
      if (failure !== null) return
      lexer.push(fragment)
    },
  }
}

/** One `{find, replace}` pair as it streams in. */
export type PartialEdit = {
  /** The anchor text to locate. Null until its own value has closed. */
  find: string | null
  /** Replacement text so far, safe to publish as a prefix. */
  replace: string
  /** True once the replacement's closing quote was read. */
  replaceComplete: boolean
}

export type PartialJsonEditScanner = {
  push: (fragment: string) => void
  /** Edits in array order, growing as they stream. */
  edits: () => PartialEdit[]
  /** Completed top-level string fields (e.g. `pageId`). */
  fields: () => Record<string, string>
  error: () => string | null
}

type EditState = {
  find: string | null
  findRaw: string
  replaceRaw: string
  replaceComplete: boolean
}

const EDITS_KEY = 'edits'
const FIND_KEY = 'find'
const REPLACE_KEY = 'replace'

/**
 * Reads a streaming `edits: [{find, replace}]` array.
 *
 * `find` is what anchors an edit in the existing document, so it is read whole
 * before its `replace` starts streaming — which is exactly the order a model
 * emits them in schema order, and what lets a viewer jump to the edit site
 * before any replacement text exists.
 */
export const createPartialJsonEditScanner = (): PartialJsonEditScanner => {
  const completedFields: Record<string, string> = {}
  const states: EditState[] = []

  let failure: string | null = null
  let current: { index: number; field: 'find' | 'replace' } | null = null
  let trackedKey: string | null = null
  let trackedValue = ''

  const stateAt = (index: number): EditState => {
    while (states.length <= index) {
      states.push({ find: null, findRaw: '', replaceComplete: false, replaceRaw: '' })
    }
    return states[index]!
  }

  const lexer = createJsonLexer({
    appendText: (text) => {
      if (trackedKey !== null) {
        if (trackedValue.length < MAX_TRACKED_FIELD_LENGTH) trackedValue += text
        return
      }
      if (!current) return
      const state = stateAt(current.index)
      if (current.field === 'find') {
        state.findRaw += text
        return
      }
      state.replaceRaw += text
    },
    beginValue: (path) => {
      trackedKey = null
      current = null
      // edits[<index>].<field>
      if (path.length === 3 && path[0] === EDITS_KEY && typeof path[1] === 'number') {
        const field = path[2]
        if (field === FIND_KEY || field === REPLACE_KEY) {
          current = { field, index: path[1] }
          return 'capture'
        }
        return 'ignore'
      }
      if (path.length === 1 && typeof path[0] === 'string') {
        trackedKey = path[0]
        trackedValue = ''
        return 'capture'
      }
      return 'ignore'
    },
    endValue: () => {
      if (trackedKey !== null) {
        completedFields[trackedKey] = trackedValue
        trackedKey = null
        trackedValue = ''
        return
      }
      if (!current) return
      const state = stateAt(current.index)
      if (current.field === 'find') {
        state.find = state.findRaw
      } else {
        state.replaceComplete = true
      }
      current = null
    },
    fail: (message) => {
      failure ??= message
    },
  })

  return {
    edits: () =>
      states.map((state) => ({
        find: state.find,
        replace: committedPrefix(state.replaceRaw),
        replaceComplete: state.replaceComplete,
      })),
    error: () => failure,
    fields: () => ({ ...completedFields }),
    push: (fragment) => {
      if (failure !== null) return
      lexer.push(fragment)
    },
  }
}
