import { useCallback, useEffect, useState } from 'react'
import type { DeepWaterBriefView } from '@nessie/schemas'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import {
  NO_EDITS,
  briefAfterEdits,
  hasLocalEdits,
  rebaseEdits,
  type BriefEdits,
} from './brief-edits'
import {
  EMPTY_BRIEF_DRAFT,
  draftAfterSend,
  isBriefDraftEmpty,
  reviveBriefDraft,
  sendAgainMessage,
  settleSentAction,
  type BriefDraft,
  type SentBriefAction,
} from './brief-sent-action'

/**
 * The person's unsent work on one brief — the reply they are typing, their
 * edits to the pillars and settings, and the action they last sent — kept
 * through `useDraft` (`draft:research-brief:<runId>`), so closing the dialog
 * or reloading loses nothing (docs/navigation content-and-drafts §15).
 *
 * Two things only this hook knows (amendments-fable F8):
 * - **Rebase.** When the brief moves on underneath unsent edits (the planner
 *   answered, or an action was refused as a revision conflict and the brief
 *   was fetched again), the edits are kept on top of the new brief and the
 *   dialog is told what DeepWater changed.
 * - **Restore.** What an action carried leaves the draft when it is sent, but
 *   is held until the brief shows how the action ended
 *   (`settleSentAction`): a refusal gives its words and edits back, and a
 *   reply the planner could not answer gives its words back and is what Send
 *   again sends. While it is held, its edits are still shown
 *   (`inFlightEdits`).
 */

type BriefBase = Pick<DeepWaterBriefView, 'lockedSettings' | 'pillars' | 'revision' | 'settings'>

export const useBriefDraft = (brief: DeepWaterBriefView) => {
  const { draft, setDraft } = useDraft<BriefDraft>(draftKey('research-brief', brief.id), {
    initial: EMPTY_BRIEF_DRAFT,
    isEmpty: isBriefDraftEmpty,
    revive: reviveBriefDraft,
  })
  const [base, setBase] = useState<BriefBase>(brief)
  const [changed, setChanged] = useState<string[]>([])
  const sent = draft.sent

  // The brief moved on: carry the unsent edits over and say what changed. What
  // the person already sent counts as theirs, not as DeepWater's change.
  useEffect(() => {
    if (brief.revision === base.revision) return
    setBase(brief)
    if (!hasLocalEdits(draft.edits)) return
    const before = sent && sent.revision === base.revision ? briefAfterEdits(base, sent.edits) : base
    const rebase = rebaseEdits(before, brief, draft.edits)
    setDraft((current) => ({ ...current, edits: rebase.edits }))
    if (rebase.changed.length > 0) setChanged(rebase.changed)
    // Keyed on the revision alone: a refetch at the same revision changes
    // nothing a rebase would read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief.revision])

  // How the last sent action ended, read off every brief the dialog sees.
  const { pendingAction, plannerTurn, revision, status } = brief
  useEffect(() => {
    const progress = { pendingAction, plannerTurn, revision, status }
    if (settleSentAction(draft, progress)) {
      setDraft((current) => settleSentAction(current, progress) ?? current)
    }
  }, [draft, pendingAction, plannerTurn, revision, setDraft, status])

  const setMessage = useCallback((message: string) => {
    setDraft((current) => ({ ...current, message }))
  }, [setDraft])

  const setEdits = useCallback((update: (edits: BriefEdits) => BriefEdits) => {
    setDraft((current) => ({ ...current, edits: update(current.edits) }))
  }, [setDraft])

  /**
   * The server accepted this action: what it carried leaves the draft (only
   * while it still equals what was sent), and the action is held until the
   * brief says how it ended.
   */
  const markSent = useCallback((action: SentBriefAction) => {
    setChanged([])
    setDraft((current) => draftAfterSend(current, action))
  }, [setDraft])

  return {
    changed,
    dismissChanged: () => setChanged([]),
    draft,
    /**
     * The edits of the action in flight, until the brief shows them. The API
     * answers an action before DeepWater has applied its edits, so without this
     * a person's sent pillars and settings would seem to vanish until the
     * next read; once the brief moves past the revision they were sent
     * against, it carries them itself.
     */
    inFlightEdits: sent && sent.revision === brief.revision ? sent.edits : NO_EDITS,
    markSent,
    /** What Send again sends after the planner could not answer, or null when nothing is known. */
    sendAgain: sendAgainMessage(draft.unanswered, brief),
    setEdits,
    setMessage,
  }
}
