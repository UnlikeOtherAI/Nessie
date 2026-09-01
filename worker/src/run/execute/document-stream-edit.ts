import type { PartialEdit } from '@nessie/schemas'

/**
 * Turns a streaming `edits: [{find, replace}]` array into positioned changes to
 * a document that already exists.
 *
 * Edits are processed strictly in order and one at a time. An edit is
 * *anchored* the moment its `find` value closes — before any replacement text
 * exists — which is what lets a viewer move to the change site and wait there,
 * rather than discovering where the change was after it finished.
 *
 * `find` must match exactly once. Ambiguous or absent anchors are skipped here
 * rather than guessed at: the tool handler applies the same rule and reports
 * the failure to the model, so a preview never shows a change that will not be
 * saved.
 */

export type EditSink = {
  /** An edit was located: `removeLength` units at `offset` are being replaced. */
  beginEdit: (step: { editIndex: number; offset: number; removeLength: number }) => void
  /** Replacement text arriving at `offset`. */
  insert: (step: { content: string; offset: number }) => void
}

export type DocumentEditTracker = {
  /** Feed the scanner's current view; publishes whatever is newly determinable. */
  pump: (edits: readonly PartialEdit[], sink: EditSink) => void
  /** The document as it now stands, with everything published so far applied. */
  composed: () => string
  /** Edits whose anchor could not be located exactly once. */
  unanchored: () => number[]
}

type ActiveEdit = {
  anchored: boolean
  index: number
  offset: number
  publishedReplaceLength: number
  skipped: boolean
}

/** Count of non-overlapping occurrences, capped — we only care about 0/1/many. */
const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  while (count < 2) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) break
    count += 1
    from = at + needle.length
  }
  return count
}

export const createDocumentEditTracker = (baseDocument: string): DocumentEditTracker => {
  let composed = baseDocument
  const unanchored: number[] = []
  let active: ActiveEdit = {
    anchored: false,
    index: 0,
    offset: 0,
    publishedReplaceLength: 0,
    skipped: false,
  }

  const advance = (): void => {
    active = {
      anchored: false,
      index: active.index + 1,
      offset: 0,
      publishedReplaceLength: 0,
      skipped: false,
    }
  }

  return {
    composed: () => composed,
    unanchored: () => [...unanchored],
    pump: (edits, sink) => {
      // Loop so a batch that completes several short edits at once still
      // publishes each of them in order.
      for (;;) {
        const edit = edits[active.index]
        if (!edit) return

        if (!active.anchored && !active.skipped) {
          // The anchor is only usable once its own value has closed; a partial
          // `find` would match the wrong place.
          if (edit.find === null) return
          const occurrences = countOccurrences(composed, edit.find)
          if (occurrences !== 1) {
            active.skipped = true
            unanchored.push(active.index)
          } else {
            const offset = composed.indexOf(edit.find)
            active.anchored = true
            active.offset = offset
            composed = composed.slice(0, offset) + composed.slice(offset + edit.find.length)
            sink.beginEdit({
              editIndex: active.index,
              offset,
              removeLength: edit.find.length,
            })
          }
        }

        if (active.anchored) {
          const replace = edit.replace
          if (replace.length > active.publishedReplaceLength) {
            const content = replace.slice(active.publishedReplaceLength)
            const at = active.offset + active.publishedReplaceLength
            composed = composed.slice(0, at) + content + composed.slice(at)
            active.publishedReplaceLength = replace.length
            sink.insert({ content, offset: at })
          }
        }

        // Only move on once this edit is finished, so ordering is preserved.
        if (!edit.replaceComplete) return
        advance()
      }
    },
  }
}

/**
 * Apply the same edits the tracker previewed, for the durable save.
 *
 * Deliberately a separate, simple pass over the *final* arguments rather than
 * a reuse of the streaming state: the save must be correct on its own terms,
 * and the two agreeing is what the streamed-equals-saved check verifies.
 */
export const applyDocumentEdits = (
  document: string,
  edits: readonly { find: string; replace: string }[],
): { applied: string } => {
  let result = document
  edits.forEach((edit, index) => {
    if (edit.find.length === 0) {
      throw new Error(`Edit ${index + 1} has an empty "find" — nothing to locate.`)
    }
    const occurrences = countOccurrences(result, edit.find)
    if (occurrences === 0) {
      throw new Error(
        `Edit ${index + 1} did not match the document. Read the current content and `
        + 'use an exact snippet from it.',
      )
    }
    if (occurrences > 1) {
      throw new Error(
        `Edit ${index + 1} matches the document more than once. Include more surrounding `
        + 'text so it identifies one place.',
      )
    }
    const at = result.indexOf(edit.find)
    result = result.slice(0, at) + edit.replace + result.slice(at + edit.find.length)
  })
  return { applied: result }
}
