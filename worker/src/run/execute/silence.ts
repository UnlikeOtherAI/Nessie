import type { RunExecuteJobPayload, ToolSchemaDescriptor } from '@nessie/schemas'

import { isInteractiveRun } from './continuation.js'

/**
 * Letting a run conclude without posting.
 *
 * A monitoring agent on a schedule is mostly supposed to say nothing. Before
 * this, every run ended in `completion.ts` writing a message, so a 15-minute
 * sweep announced "nothing changed" ninety-six times a day and the channel it
 * was meant to protect became unreadable.
 *
 * Silence is chosen by the model and observed structurally. The model calls
 * `conclude_silently`; the code reacts to the *fact of the tool call*, never to
 * what the prose said — inspecting the final text for "nothing to report"
 * would be exactly the string-matching of natural-language intent that
 * `AGENTS.md` forbids, and it would also mistake a provider returning an empty
 * completion (a real failure mode) for a deliberate decision.
 *
 * The tool is offered only to runs where silence is a coherent answer. An
 * @mention that returned nothing would look broken to the person who asked, so
 * an interactive turn structurally cannot go quiet.
 */

export const CONCLUDE_SILENTLY_TOOL_NAME = 'conclude_silently'

export const CONCLUDE_SILENTLY_DESCRIPTOR: ToolSchemaDescriptor = {
  toolName: CONCLUDE_SILENTLY_TOOL_NAME,
  description:
    'End this run without posting anything to the channel. Use it when you '
    + 'checked and there is nothing the reader needs to know — no new problem, '
    + 'nothing that changed since your last report. Silence is the normal '
    + 'outcome of a routine check; posting "all clear" is not. Call this as '
    + 'your final action, after you have finished looking. Anything you write '
    + 'afterwards is discarded, so do not use it when you have something to say.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description:
          'One short line, for the run log only, saying what you checked and '
          + 'why it did not warrant a message. Never shown in the channel.',
      },
    },
    // No `required` key at all: every other builtin declares at least one
    // required argument, and an empty array is a shape no provider here is
    // exercised with. Absent means "nothing required" in JSON Schema anyway.
  },
}

export type SilenceSink = {
  /** True once the model has asked for this run to end without posting. */
  readonly concluded: boolean
  /** The model's own note, kept for the activity log. */
  readonly reason: string | null
  record: (args: Record<string, unknown>) => string
}

export const createSilenceSink = (): SilenceSink => {
  let concluded = false
  let reason: string | null = null
  return {
    get concluded() {
      return concluded
    },
    get reason() {
      return reason
    },
    record: (args) => {
      concluded = true
      const raw = typeof args.reason === 'string' ? args.reason.trim() : ''
      reason = raw.length > 0 ? raw.slice(0, 500) : null
      return 'Acknowledged — this run will end without posting to the channel.'
    },
  }
}

/**
 * Whether this run may choose silence.
 *
 * Excluded, each for a different reason:
 * - **interactive turns** — somebody is waiting for an answer;
 * - **DeepWater handoff turns** — their message flow is a fixed contract;
 * - **workflow steps** — a parent step consumes this run's `responseText`, so
 *   producing none would starve it.
 */
export const isSilenceEligible = (input: {
  handoffLocator: unknown | null
  payload: RunExecuteJobPayload
}): boolean =>
  !isInteractiveRun(input.payload)
  && input.handoffLocator === null
  && !input.payload.parentPlanId
