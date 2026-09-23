import { useCallback, useEffect, useState } from 'react'
import type { DeepWaterBriefView } from '@nessie/schemas'
import { draftKey, useDraft } from '../../../navigation/useDraft'
import {
  NO_EDITS,
  briefAfterEdits,
  hasLocalEdits,
  layerEdits,
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
 *   edits come back into the draft, so trying again is one tap. While it is
 *   held, its edits are still shown (`inFlightEdits`).
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

/** An action that went out, with what it carried and the revision it was sent against. */
type Sent = { actionId: string; draft: BriefDraft; revision: number | null }

export const useBriefDraft = (brief: DeepWaterBriefView) => {
  const { draft, setDraft, clear } = useDraft<BriefDraft>(draftKey('research-brief', brief.id), {
    initial: EMPTY_DRAFT,
    isEmpty: (value) => value.message.trim() === '' && !hasLocalEdits(value.edits),
    revive: reviveDraft,
  })
  const [base, setBase] = useState<BriefBase>(brief)
  const [changed, setChanged] = useState<string[]>([])
  const [sent, setSent] = useState<Sent | null>(null)

  // The brief moved on: carry the unsent edits over and say what changed. What
  // the person already sent counts as theirs, not as DeepWater's change.
  useEffect(() => {
    if (brief.revision === base.revision) return
    setBase(brief)
    if (!hasLocalEdits(draft.edits)) return
    const before = sent && sent.revision === base.revision ? briefAfterEdits(base, sent.draft.edits) : base
    const rebase = rebaseEdits(before, brief, draft.edits)
    setDraft((current) => ({ ...current, edits: rebase.edits }))
    if (rebase.changed.length > 0) setChanged(rebase.changed)
    // Keyed on the revision alone: a refetch at the same revision changes
    // nothing a rebase would read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brief.revision])

  // How the last sent action ended, read off the brief. The API's answer can
  // reach this component after the send settles, so a brief that does not yet
  // name the action is not taken as its end: the action is over only when the
  // brief names it with an error, names another action, or has moved past the
  // revision it was sent against.
  const pending = brief.pendingAction
  const revisionNow = brief.revision
  useEffect(() => {
    if (!sent) return
    const ours = pending?.actionId === sent.actionId
    if (ours && pending.error !== null) {
      setDraft((current) => ({
        edits: layerEdits(sent.draft.edits, current.edits),
        message: current.message.trim() === '' ? sent.draft.message : current.message,
      }))
      setSent(null)
      return
    }
    if (ours) return
    if (pending || revisionNow !== sent.revision) setSent(null)
  }, [pending, revisionNow, sent, setDraft])

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
  const revision = brief.revision
  const markSent = useCallback((actionId: string, what: BriefDraft, typedMessageSent: boolean) => {
    setSent({ actionId, draft: what, revision })
    setChanged([])
    if (typedMessageSent) {
      clear()
      return
    }
    setDraft((current) => ({ ...current, edits: NO_EDITS }))
  }, [clear, revision, setDraft])

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
    inFlightEdits: sent && sent.revision === brief.revision ? sent.draft.edits : NO_EDITS,
    markSent,
    setEdits,
    setMessage,
  }
}
