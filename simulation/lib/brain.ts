const OPENAI_API_KEY = process.env.OPENAI_CHAT_API_KEY ?? process.env.OPENAI_API_KEY ?? ''
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? ''

const ANTHROPIC_MODEL = process.env.SIM_BRAIN_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001'
const OPENAI_MODEL = process.env.SIM_BRAIN_OPENAI_MODEL ?? 'gpt-4o-mini'

export type BrainDecision = {
  action: string
  args: Record<string, unknown>
  rationale: string
}

const SYSTEM_PROMPT = `You roleplay an employee at a small company called Acme Sim Co. You are given:
- Your persona (name, role, department).
- Recent activity you've taken or witnessed.
- An action vocabulary you may pick from.

Reply with a single JSON object: { "action": "<verb>", "args": { ... }, "rationale": "one short sentence in character" }.

Stay in character. Be concise. Prefer actions that move your role's work forward. Never try to break the database, scrape secrets, or attack the platform. If you have nothing useful to do, pick "idle" with a short rationale.`

const safeParseJson = (raw: string): BrainDecision | null => {
  const trimmed = raw.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as BrainDecision
  } catch {
    return null
  }
}

const callAnthropic = async (userPrompt: string): Promise<string> => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { content: { type: string; text: string }[] }
  return body.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

const callOpenAi = async (userPrompt: string): Promise<string> => {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.6,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { choices: { message: { content: string } }[] }
  return body.choices[0]?.message?.content ?? ''
}

export const decide = async (userPrompt: string): Promise<BrainDecision> => {
  const raw = ANTHROPIC_API_KEY
    ? await callAnthropic(userPrompt)
    : OPENAI_API_KEY
    ? await callOpenAi(userPrompt)
    : (() => {
        throw new Error('no brain API key set (ANTHROPIC_API_KEY or OPENAI_API_KEY)')
      })()
  const parsed = safeParseJson(raw)
  if (!parsed || !parsed.action) {
    return { action: 'idle', args: {}, rationale: `brain returned unparseable: ${raw.slice(0, 120)}` }
  }
  return parsed
}

export const activeBrain = (): string => (ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : OPENAI_API_KEY ? OPENAI_MODEL : 'none')
