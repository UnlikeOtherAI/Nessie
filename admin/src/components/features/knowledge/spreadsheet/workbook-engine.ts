// The one place the browser engine is loaded and a workbook is built from a
// bootstrap. Kept out of `WorkbookHost.tsx` so the pane's test can exercise the
// engine without React, and so the `init()` promise is shared by every host a
// session mounts (fullscreen re-parents the same model, but a second pane in a
// second tab of the same document must not re-instantiate the wasm).
import { init, Model } from '@ironcalc/workbook'
import wasmUrl from '@ironcalc/wasm/wasm_bg.wasm?url'
import type { SpreadsheetAppliedBatch, SpreadsheetBootstrap } from '@nessie/schemas'

let engineReady: Promise<void> | null = null

/** Idempotent. The 1.9 MB wasm is fetched exactly once per page load. */
export const initSpreadsheetEngine = async (): Promise<void> => {
  engineReady ??= init({ module_or_path: wasmUrl }).then(() => undefined)
  await engineReady
}

export const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export type BuiltWorkbook = {
  /** The last seq the model has seen; Phase 3b's `appliedSeq` starts here. */
  appliedSeq: number
  model: Model
  /** Batches the bootstrap carried without inline diffs — 3b fetches them. */
  missingSeqs: number[]
}

/**
 * Bootstrap → live model: `from_bytes` of the hot snapshot, then every batch
 * since applied **paused** (un-paused, 200 000 diffs took 38 minutes against
 * 164 ms paused), then one `evaluate()`.
 *
 * A batch whose `diffs` came back null exceeded the fan-out cap and has to be
 * fetched by seq. Applying the batches after it would put the model in a state
 * no seq describes, so the build stops at the gap and reports it.
 */
export const buildWorkbook = (bootstrap: SpreadsheetBootstrap): BuiltWorkbook => {
  const model = Model.from_bytes(decodeBase64(bootstrap.snapshot.bytes), 'en')
  // The snapshot's own load queues nothing worth sending, but drain it anyway
  // so the first local edit is not shipped with the whole workbook behind it.
  model.flushSendQueue()

  const ordered = [...bootstrap.batches].sort(
    (left: SpreadsheetAppliedBatch, right: SpreadsheetAppliedBatch) => left.seq - right.seq,
  )
  let appliedSeq = bootstrap.snapshot.seq
  const missingSeqs: number[] = []
  model.pauseEvaluation()
  try {
    for (const batch of ordered) {
      if (batch.seq <= appliedSeq) continue
      if (batch.diffs === null) {
        missingSeqs.push(batch.seq)
        break
      }
      model.applyExternalDiffs(decodeBase64(batch.diffs))
      appliedSeq = batch.seq
    }
  } finally {
    model.resumeEvaluation()
  }
  model.evaluate()
  model.flushSendQueue()
  return { appliedSeq, missingSeqs, model }
}
