import type { LedgerAttribution, ModelClient } from '@nessie/runtime'

export type ThoughtMetadata = {
  people: string[]
  topics: string[]
  type: 'note' | 'task' | 'idea' | 'observation' | 'decision' | 'constraint' | 'preference'
  actionItems: string[]
  dates: string[]
}

const EXTRACTION_PROMPT = `Extract structured metadata from this text. Return JSON only.

Fields:
- people: array of names mentioned (empty array if none)
- topics: array of key subjects (2-5 items)
- type: one of "note", "task", "idea", "observation", "decision", "constraint", "preference"
- actionItems: array of action items (empty array if none)
- dates: array of dates or deadlines mentioned (empty array if none)

Text: `

export const extractMetadata = async (
  content: string,
  client: ModelClient,
  usage?: LedgerAttribution,
): Promise<ThoughtMetadata> => {
  try {
    const parsed = await client.chatJson<Partial<ThoughtMetadata>>(
      [
        { role: 'system', content: 'You extract structured metadata from text. Return valid JSON only.' },
        { role: 'user', content: `${EXTRACTION_PROMPT}${content.slice(0, 4000)}` },
      ],
      { maxTokens: 512, temperature: 0, usage },
    )

    return {
      people: Array.isArray(parsed.people) ? parsed.people : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics : [],
      type: parsed.type ?? 'note',
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates : [],
    }
  } catch {
    return { people: [], topics: [], type: 'note', actionItems: [], dates: [] }
  }
}
