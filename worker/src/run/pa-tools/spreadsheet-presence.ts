import {
  publishSpreadsheetPresence,
  publishSpreadsheetPresenceLeave,
  type SpreadsheetServiceDeps,
  type SpreadsheetWriteActor,
} from '@nessie/knowledge'
import { SPREADSHEET_LIMITS, type SpreadsheetSelection } from '@nessie/schemas'

/**
 * An agent editing a spreadsheet looks like a person editing a spreadsheet.
 *
 * Not decoration. A person watching a document they care about needs to see
 * *where* an agent is working and *what it is about to put there* before the
 * value changes under them — that is the whole of the case for having no
 * approval gate on these writes. So an agent publishes the same frames on the
 * same lane a browser does: a selection on the range it is reading or about to
 * write, a cursor at its top-left, and — for a small write — a short draft
 * choreography, one cell at a time, before the batch lands.
 *
 * The choreography is **bounded and honest**. It is skipped entirely above
 * `DRAFT_CELL_LIMIT` cells, and the whole sequence is capped at
 * `DRAFT_BUDGET_MS`, because a five-thousand-cell write must not spend a
 * minute pretending to type. What a person sees is either the real
 * cell-by-cell approach to a small edit, or a selection and then the result —
 * never a fabricated typing animation over work that did not happen that way.
 *
 * docs/plans/2026-09-15-spreadsheets-ironcalc/agent-tools.md §Agent presence
 */

/** Above this, a write announces its range and then simply lands. */
export const DRAFT_CELL_LIMIT = 20
export const DRAFT_STEP_MS = 120
export const DRAFT_BUDGET_MS = 2_500

export type PresenceFrame = {
  clientId: string
  sheet: number
  selection: SpreadsheetSelection
  cursor: { r: number; c: number } | null
  draft: { r: number; c: number; text: string } | null
  ts: string
}

export type AgentPresencePlan = {
  /** The frame published as soon as the tool knows what it is touching. */
  arrival: PresenceFrame
  /** Cell-by-cell drafts, in order, each `delayMs` after the previous frame. */
  drafts: { frame: PresenceFrame; delayMs: number }[]
  /** Published after the batch is acknowledged: selection kept, draft cleared. */
  settled: PresenceFrame
}

export type PresencePlanInput = {
  clientId: string
  sheet: number
  selection: SpreadsheetSelection
  /** Row-major, anchored at the selection's top-left. Absent for a read. */
  rows?: readonly (readonly (string | number | boolean | null)[])[]
  now: Date
}

const cellText = (value: string | number | boolean | null | undefined): string =>
  value === null || value === undefined
    ? ''
    : String(value).slice(0, SPREADSHEET_LIMITS.maxDraftChars)

/**
 * A pure function, tested on its own, because every interesting property of the
 * choreography is a property of the *plan* — the order, the cap, the budget,
 * the cleared draft at the end — and none of them is worth a realtime transport
 * to assert.
 */
export const planAgentPresence = (input: PresencePlanInput): AgentPresencePlan => {
  const base = {
    clientId: input.clientId,
    sheet: input.sheet,
    selection: input.selection,
    cursor: { r: input.selection.r0, c: input.selection.c0 },
    ts: input.now.toISOString(),
  }
  const arrival: PresenceFrame = { ...base, draft: null }

  const cells = input.rows
    ? input.rows.reduce((total, row) => total + row.length, 0)
    : 0
  const drafts: AgentPresencePlan['drafts'] = []
  if (input.rows && cells > 0 && cells <= DRAFT_CELL_LIMIT) {
    // The budget, not the count, is the real bound: twenty cells at 120 ms is
    // 2.4 s, and a slower step would otherwise stretch a run's wall clock for
    // the sake of an animation.
    const step = Math.max(1, Math.min(DRAFT_STEP_MS, Math.floor(DRAFT_BUDGET_MS / cells)))
    let elapsed = 0
    for (const [rowOffset, row] of input.rows.entries()) {
      for (const [columnOffset, value] of row.entries()) {
        if (elapsed + step > DRAFT_BUDGET_MS) break
        elapsed += step
        drafts.push({
          delayMs: step,
          frame: {
            ...base,
            draft: {
              r: input.selection.r0 + rowOffset,
              c: input.selection.c0 + columnOffset,
              text: cellText(value),
            },
          },
        })
      }
    }
  }

  return { arrival, drafts, settled: { ...base, draft: null } }
}

export type PresencePublisher = {
  /** The tool is looking at, or about to write, this range. */
  announce: (input: Omit<PresencePlanInput, 'now' | 'clientId'>) => Promise<void>
  /** The batch landed: keep the selection, drop the draft. */
  settle: (input: Omit<PresencePlanInput, 'now' | 'clientId' | 'rows'>) => Promise<void>
  /** The run finished with this page. */
  leave: () => Promise<void>
}

export type PresencePublisherInput = {
  organizationId: string
  pageId: string
  actor: SpreadsheetWriteActor
  /**
   * One presence participant per run. `agent-tools.md` says `runId:pageId`,
   * but a presence frame's `clientId` is capped at 64 characters and two uuids
   * with a separator are 73 — the frame was silently refused. The page is not
   * needed to disambiguate anyway: frames are published on that page's own
   * lane, so a run is already one participant per document.
   */
  clientId: string
  canWrite: boolean
  sleep?: (ms: number) => Promise<void>
  now?: () => Date
}

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/**
 * Publishing is best-effort by construction.
 *
 * Presence is ephemeral and unrecoverable by design (`realtime-and-presence.md`
 * §7): a dropped frame costs a peer one heartbeat of staleness. Failing a tool
 * call because the animation did not go out would trade a real edit for a
 * cosmetic one.
 */
export const createAgentPresencePublisher = (
  deps: SpreadsheetServiceDeps,
  input: PresencePublisherInput,
): PresencePublisher => {
  const sleep = input.sleep ?? sleepFor
  const now = input.now ?? (() => new Date())

  const publish = async (frame: PresenceFrame): Promise<void> => {
    try {
      await publishSpreadsheetPresence(deps, {
        organizationId: input.organizationId,
        pageId: input.pageId,
        actor: input.actor,
        frame,
        canWrite: input.canWrite,
      })
    } catch {
      // Ephemeral by design; the next frame supersedes this one.
    }
  }

  return {
    announce: async (plan) => {
      const planned = planAgentPresence({ ...plan, clientId: input.clientId, now: now() })
      await publish(planned.arrival)
      for (const step of planned.drafts) {
        await sleep(step.delayMs)
        await publish(step.frame)
      }
    },
    settle: async (plan) => {
      const planned = planAgentPresence({ ...plan, clientId: input.clientId, now: now() })
      await publish(planned.settled)
    },
    leave: async () => {
      try {
        await publishSpreadsheetPresenceLeave(deps, {
          organizationId: input.organizationId,
          pageId: input.pageId,
          clientId: input.clientId,
        })
      } catch {
        // Peers wait out the expiry instead of seeing the avatar disappear.
      }
    },
  }
}
