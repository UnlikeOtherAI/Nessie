export type ThoughtMetadata = {
  people: string[]
  topics: string[]
  type: 'note' | 'task' | 'idea' | 'observation' | 'decision' | 'constraint' | 'preference'
  actionItems: string[]
  dates: string[]
}

export type ExtractionConfig = {
  apiKey: string
  model?: string
  baseUrl?: string
}

const DEFAULT_MODEL = 'gpt-5-mini'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

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
  config: ExtractionConfig,
): Promise<ThoughtMetadata> => {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You extract structured metadata from text. Return valid JSON only.' },
        { role: 'user', content: `${EXTRACTION_PROMPT}${content.slice(0, 4000)}` },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 512,
      temperature: 0,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Metadata extraction error ${response.status}: ${errorText}`)
  }

  const result = (await response.json()) as {
    choices: { message: { content: string } }[]
  }

  const raw = result.choices[0]?.message.content
  if (!raw) {
    return { people: [], topics: [], type: 'note', actionItems: [], dates: [] }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThoughtMetadata>
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
