import type { LedgerAttribution, ModelClient } from '@nessie/runtime'

export type ReasoningExtraction = {
  hasReasoning: boolean
  reasoningType: 'decision' | 'evaluation' | 'constraint' | 'pattern' | 'correction' | 'validation'
  alternatives: string[] | null
  criteria: string[] | null
  constraints: string[] | null
  tradeoffs: string | null
  confidence: number
  reasoningSummary: string
}

const NO_REASONING: ReasoningExtraction = {
  hasReasoning: false,
  reasoningType: 'decision',
  alternatives: null,
  criteria: null,
  constraints: null,
  tradeoffs: null,
  confidence: 0,
  reasoningSummary: '',
}

const REASONING_PROMPT = `Analyze this text for decision reasoning. Return JSON only.

If the text contains a decision, preference, architectural choice, trade-off, evaluation, or constraint, extract:
{
  "hasReasoning": true,
  "reasoningType": "decision" | "evaluation" | "constraint" | "pattern" | "correction" | "validation",
  "alternatives": ["option A", "option B"] or null if not mentioned,
  "criteria": ["criterion 1", "criterion 2"] or null if not mentioned,
  "constraints": ["constraint 1"] or null if not mentioned,
  "tradeoffs": "what was gained vs sacrificed" or null,
  "confidence": 0.0 to 1.0 (how confident the decision-maker seems),
  "reasoningSummary": "one paragraph explaining the logic behind the decision"
}

If the text is a simple note, observation, or information without decision logic:
{
  "hasReasoning": false,
  "reasoningType": "decision",
  "alternatives": null,
  "criteria": null,
  "constraints": null,
  "tradeoffs": null,
  "confidence": 0,
  "reasoningSummary": ""
}

Text: `

export const extractReasoning = async (
  content: string,
  client: ModelClient,
  usage?: LedgerAttribution,
): Promise<ReasoningExtraction> => {
  try {
    const parsed = await client.chatJson<Partial<ReasoningExtraction>>(
      [
        {
          role: 'system',
          content: [
            'You analyze text for decision reasoning.',
            'Return valid JSON only.',
            'Be precise about what alternatives were',
            'considered and what criteria drove the decision.',
          ].join(' '),
        },
        { role: 'user', content: `${REASONING_PROMPT}${content.slice(0, 4000)}` },
      ],
      { maxTokens: 1024, temperature: 0, usage },
    )

    if (!parsed.hasReasoning) {
      return NO_REASONING
    }

    return {
      hasReasoning: true,
      reasoningType: parsed.reasoningType ?? 'decision',
      alternatives: Array.isArray(parsed.alternatives) ? parsed.alternatives : null,
      criteria: Array.isArray(parsed.criteria) ? parsed.criteria : null,
      constraints: Array.isArray(parsed.constraints) ? parsed.constraints : null,
      tradeoffs: typeof parsed.tradeoffs === 'string' ? parsed.tradeoffs : null,
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      reasoningSummary: parsed.reasoningSummary ?? '',
    }
  } catch {
    return NO_REASONING
  }
}
