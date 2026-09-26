import {
  confidentChoice,
  decisionChoice,
  decisionExcerpt,
  type DecisionModelClient,
  type LedgerAttribution,
} from '@nessie/runtime'

import type { ConsolidationCandidateExtractor } from './consolidation-candidates.js'
import type { ThoughtMetadata } from './extract-metadata.js'

/**
 * Jev in front of a capture's two generative extractions
 * (docs/standards/tech-and-run-budgets.md → "Jev gates"). Every captured message used
 * to pay for both: structured metadata and decision reasoning, each a JSON
 * generation on the deployment's model. Most chat messages carry neither — a
 * thank-you has no topics, a status line has no trade-off — so Jev is asked
 * once whether each is worth generating, and only a sure "no" skips one.
 * Anything unsure, and any failure, extracts exactly as before.
 */

/** Below this, an answer is treated as not given. The channel policy's starter value. */
export const EXTRACTION_GATE_MINIMUM_PROBABILITY = 0.8

/** Capture is fire-and-forget, but a stalled gate still holds its pool slot. */
const EXTRACTION_GATE_TIMEOUT_MS = 4_000

const KINDS: Record<ThoughtMetadata['type'], string> = {
  note: 'Information worth keeping that is none of the kinds below.',
  task: 'Something someone has to do.',
  idea: 'A proposal or possibility, not yet decided.',
  observation: 'Something someone noticed or reported about how things are.',
  decision: 'A choice that has been made.',
  constraint: 'A limit, requirement or rule that has to be respected.',
  preference: 'How someone likes things done.',
}

const QUESTIONS = {
  substance: decisionChoice(
    'Is there anything in this text worth indexing for later recall — a person, a topic, a task, '
    + 'a date, a fact, a preference or a decision?',
    {
      substantive: 'Yes: it says something someone may want to find again.',
      filler: 'No: a greeting, thanks, an acknowledgement, or a short reply that says nothing on its own.',
    },
  ),
  kind: decisionChoice('What kind of note is this text?', KINDS),
  reasoning: decisionChoice(
    'Does this text explain a decision — why an option was chosen, what was weighed against what, '
    + 'a trade-off, an evaluation, or the constraint behind a choice?',
    {
      present: 'Yes: it gives the reasons behind a choice or an evaluation.',
      absent: 'No: it states things, asks, or reports without the reasoning behind a choice.',
    },
  ),
}

export type ExtractionGate = {
  /** Set when Jev is sure there is nothing to extract: the metadata to store instead. */
  metadata: ThoughtMetadata | null
  /** True when Jev is sure the text explains no decision. */
  skipReasoning: boolean
}

export const gateExtraction = async (
  client: DecisionModelClient,
  content: string,
  usage: LedgerAttribution,
): Promise<ExtractionGate | null> => {
  let answers
  try {
    answers = await client.evaluate({
      // The generative extractors read the first 4,000 characters; so does Jev.
      state: { text: decisionExcerpt(content, 4_000) },
      questions: QUESTIONS,
      timeoutMs: EXTRACTION_GATE_TIMEOUT_MS,
      usage,
    })
  } catch {
    // Including exhausted credits: the extractions then fail on their own, as before.
    return null
  }
  const pick = (id: string): string | undefined =>
    confidentChoice(answers, id, EXTRACTION_GATE_MINIMUM_PROBABILITY)
  const kind = pick('kind')
  return {
    metadata: pick('substance') === 'filler'
      ? {
          people: [],
          topics: [],
          type: kind !== undefined && Object.hasOwn(KINDS, kind) ? kind as ThoughtMetadata['type'] : 'note',
          actionItems: [],
          dates: [],
        }
      : null,
    skipReasoning: pick('reasoning') === 'absent',
  }
}

/**
 * How sure Jev must be that a run's conversation holds nothing durable before
 * its memory extraction is skipped. Higher than the capture gate's 0.8: a
 * wrong skip loses what the run's people said for good.
 */
export const CONSOLIDATION_GATE_MINIMUM_PROBABILITY = 0.9

// Jev reads at most ~24 KB per question including its state.
const CONSOLIDATION_STATE_BUDGET_BYTES = 18_000

const CONSOLIDATION_QUESTION = decisionChoice(
  'Does this conversation hold anything worth remembering beyond it — a durable fact, a preference, '
  + 'a constraint, the reason behind a decision, or an intention?',
  {
    durable: 'Yes: someone says something that will still matter in later conversations.',
    nothing: 'No: a one-off exchange — a question answered, a task done, small talk — '
      + 'with nothing that will matter later.',
  },
)

/**
 * Jev in front of a finished run's memory extraction (the same "Jev gates"
 * section). The extraction is a generative call over the run's conversation
 * after every completed run; most runs answer a question or do a task and
 * leave nothing durable. A sure "nothing" returns no candidates without the
 * call. A conversation too long for Jev to read whole, doubt, and any failure
 * extract exactly as before.
 */
export const gateCandidateExtraction = (
  client: DecisionModelClient | undefined,
  usage: LedgerAttribution,
  extract: ConsolidationCandidateExtractor,
): ConsolidationCandidateExtractor => {
  if (!client) return extract
  return async (input) => {
    // The messages as the extraction reads them, already cut to its per-message limit.
    const state = { messages: input.messages }
    // Only a conversation Jev reads whole can be judged to hold nothing.
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > CONSOLIDATION_STATE_BUDGET_BYTES) return extract(input)
    try {
      const answers = await client.evaluate({
        state, questions: { durable: CONSOLIDATION_QUESTION }, timeoutMs: EXTRACTION_GATE_TIMEOUT_MS, usage,
      })
      if (confidentChoice(answers, 'durable', CONSOLIDATION_GATE_MINIMUM_PROBABILITY) === 'nothing') {
        return { candidates: [] }
      }
    } catch {
      // Extract as before.
    }
    return extract(input)
  }
}
