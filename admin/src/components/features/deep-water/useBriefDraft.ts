import { useCallback, useEffect, useState } from 'react'
import type { DeepWaterBriefView } from '@nessie/schemas'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import {
  NO_EDITS,
  hasLocalEdits,
  rebaseEdits,
  reviveBriefEdits,
  type BriefEdits,
} from './brief-edits'

/**
 * The person's unsent work on one brief — the reply they are typing and their
 * edits to the pillars and settings — kept through `useDraft`
 * (`draft:research-brief:<runId>`), so closing the dialog or reloading loses
 * nothing (docs/navigation content-and-drafts §15).
 *
 * Two things only this hook knows (amendments-fable F8):
 * - **Rebase.** When the brief moves on underneath unsent edits (the planner
 *   answered, or an action was refused as a revision conflict and the brief
 *   was fetched again), the edits are kept on top of the new brief and the
 *   dialog is told what DeepWater changed.
 * - **Restore.** A sent reply is cleared from the draft, but held until the
 *   brief shows how its action ended; if DeepWater refused it, its words and
 *   edits come back into the draft, so trying again is one tap.
 */

export type BriefDraft = { edits: BriefEdits; message: string }

const EMPTY_DRAFT: BriefDraft = { edits: NO_EDITS, message: '' }

const reviveDraft = (stored: unknown): BriefDraft | null => {
  if (!stored || typeof stored !== 'object') return null
  const record = stored as Record<string, unknown>
  return {
    edits: reviveBriefEdits(record.edits),
    message: typeof record.message === 'string' ? record.message : '',
  }
}

type BriefBase = Pick<DeepWaterBriefView, 'lockedSettings' | 'pillars' | 'revision' | 'settings'>

type Sent = { actionId: string; draft: BriefDraft }

export const useBriefDraft = (brief: DeepWaterBriefView) => {
  const { draft, setDraft, clear } = useDraft<BriefDraft>(draftKey('research-brief', brief.id), {
    initial: EMPTY_DRAFT,
    isEmpty: (value) => value.message.trim() === '' && !hasLocalEdits(value.edits),
    revive: reviveDraft,
  })
  const [base, setBase] = useState<BriefBase>(brief)
  const [changed, setChanged] = useState<string[]>([])
  const [sent, setSent] = useState<Sent | null>(null)

  // The brief moved on: carry the unsent edits over and say what changed.
  useEffect(() => {
    if (brief.revision === base.revision) return
    setBase(brief)
    if (!hasLocalEdits(draft.edits)) return
    const rebase = rebaseEdits(base, brief, draft.edits)
    setDraft((current) => ({ ...current, edits: rebase.edits }))
    if (rebase.changed.length > 0) setChanged(rebase.changed)
    // Keyed on the revision alone: a refetch at the same revision changes
    // nothing a rebase would read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief.revision])

  // How the last sent action ended, read off the brief.
  const pending = brief.pendingAction
  useEffect(() => {
    if (!sent) return
    if (pending?.actionId !== sent.actionId) {
      setSent(null)
      return
    }
    if (pending.error === null) return
    setDraft((current) => ({
      edits: { ...sent.draft.edits, ...current.edits,
        settings: { ...sent.draft.edits.settings, ...current.edits.settings } },
      message: current.message.trim() === '' ? sent.draft.message : current.message,
    }))
    setSent(null)
  }, [pending?.actionId, pending?.error, sent, setDraft])

  const setMessage = useCallback((message: string) => {
    setDraft((current) => ({ ...current, message }))
  }, [setDraft])

  const setEdits = useCallback((update: (edits: BriefEdits) => BriefEdits) => {
    setDraft((current) => ({ ...current, edits: update(current.edits) }))
  }, [setDraft])

  /**
   * The action went out with these edits (and, for a typed reply, this
   * message): forget them from the draft, but hold them until the brief says
   * how the action ended. A one-tap answer or a resend leaves what the person
   * is typing alone.
   */
  const markSent = useCallback((actionId: string, what: BriefDraft, typedMessageSent: boolean) => {
    setSent({ actionId, draft: what })
    setChanged([])
    if (typedMessageSent) {
      clear()
      return
    }
    setDraft((current) => ({ ...current, edits: NO_EDITS }))
  }, [clear, setDraft])

  return {
    changed,
    dismissChanged: () => setChanged([]),
    draft,
    markSent,
    setEdits,
    setMessage,
  }
}
