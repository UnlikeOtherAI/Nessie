/**
 * The Gemini Live bidirectional-streaming wire protocol, as this admin speaks
 * it. Types and payload builders only — the socket lifecycle lives in
 * `gemini-live-client.ts`, and nothing here touches Nessie's API.
 *
 * The endpoint is the *constrained* BidiGenerateContent service: it is the one
 * an ephemeral, one-use credential is allowed to open, which is why the device
 * never needs a real Google API key.
 */

export const GEMINI_LIVE_URL =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained'

/** One seeded conversation turn. Roles are preserved from the DM. */
export type SeedTurn = {
  role: 'user' | 'model'
  text: string
}

export type GeminiSetupOptions = {
  model: string
  voiceName: string
  systemInstruction: string
  /** Declared functions Gemini may call; server-validated on execution. */
  functionDeclarations: Array<Record<string, unknown>>
  /** Present only when resuming an existing session across a credential rotation. */
  sessionResumptionHandle?: string | undefined
}

/**
 * The opening `setup` frame.
 *
 * Notable choices, all carried over from Coder's tuned iOS client: automatic
 * voice-activity detection with a long silence window (a person thinking
 * mid-sentence should not end their turn), interruption allowed so talking
 * over the model stops it, transcription of both directions so the call has a
 * transcript, and sliding-window context compression so a long call does not
 * die when the context window fills.
 */
export const buildSetupPayload = (
  options: GeminiSetupOptions,
): Record<string, unknown> => ({
  setup: {
    model: options.model.startsWith('models/') ? options.model : `models/${options.model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: options.voiceName } },
      },
    },
    ...(options.functionDeclarations.length > 0
      ? { tools: [{ functionDeclarations: options.functionDeclarations }] }
      : {}),
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        prefixPaddingMs: 650,
        endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
        silenceDurationMs: 2200,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: options.sessionResumptionHandle
      ? { handle: options.sessionResumptionHandle }
      : {},
    contextWindowCompression: { slidingWindow: {} },
    systemInstruction: { parts: [{ text: options.systemInstruction }] },
  },
})

/**
 * Seeds prior conversation as ordinary role-bearing turns.
 *
 * Deliberately NOT folded into `systemInstruction`: history is content the
 * people in the DM wrote, and the system instruction is the highest-trust
 * tier. Putting one inside the other would let anything ever said in the DM
 * read as an instruction to the model.
 */
export const buildSeedPayload = (turns: SeedTurn[]): Record<string, unknown> => ({
  clientContent: {
    turns: turns.map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
    // The seed is context, not a question: the model must not answer it.
    turnComplete: false,
  },
})

export const buildAudioPayload = (base64Pcm: string): Record<string, unknown> => ({
  realtimeInput: {
    audio: { mimeType: 'audio/pcm;rate=16000', data: base64Pcm },
  },
})

export const buildTextPayload = (text: string): Record<string, unknown> => ({
  realtimeInput: { text },
})

export const buildToolResponsePayload = (
  responses: Array<{ id: string; name: string; result: unknown }>,
): Record<string, unknown> => ({
  toolResponse: {
    functionResponses: responses.map((response) => ({
      id: response.id,
      name: response.name,
      response: { result: response.result },
    })),
  },
})

/** A function call the model wants executed. Execution is always server-side. */
export type GeminiToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

/** Everything the client reacts to, parsed out of one server frame. */
export type GeminiServerEvent =
  | { kind: 'setup-complete' }
  | { kind: 'user-transcript'; text: string }
  | { kind: 'assistant-transcript'; text: string }
  | { kind: 'audio'; base64: string }
  | { kind: 'turn-complete' }
  | { kind: 'interrupted' }
  | { kind: 'tool-calls'; calls: GeminiToolCall[] }
  | { kind: 'resumption-handle'; handle: string }
  | { kind: 'go-away'; timeLeft: string | null }
  | { kind: 'usage'; metadata: Record<string, unknown> }

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

/**
 * Parses one server frame into zero or more events.
 *
 * A frame routinely carries several of these at once (audio plus a
 * transcription plus usage metadata), so this returns a list rather than
 * picking the "main" one — an earlier draft that returned a single event
 * silently dropped usage on every audio frame.
 */
export const parseServerFrame = (raw: string): GeminiServerEvent[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const frame = asRecord(parsed)
  if (!frame) return []

  const events: GeminiServerEvent[] = []

  const usage = asRecord(frame['usageMetadata'])
  if (usage) events.push({ kind: 'usage', metadata: usage })

  const resumption = asRecord(frame['sessionResumptionUpdate'])
  if (resumption && resumption['resumable'] === true) {
    const handle = resumption['newHandle']
    if (typeof handle === 'string' && handle.length > 0) {
      events.push({ kind: 'resumption-handle', handle })
    }
  }

  const toolCall = asRecord(frame['toolCall'])
  const functionCalls = toolCall?.['functionCalls']
  if (Array.isArray(functionCalls)) {
    const calls = functionCalls.flatMap((entry): GeminiToolCall[] => {
      const call = asRecord(entry)
      const name = call?.['name']
      if (!call || typeof name !== 'string') return []
      const id = typeof call['id'] === 'string' ? call['id'] : name
      return [{ id, name, args: asRecord(call['args']) ?? {} }]
    })
    if (calls.length > 0) events.push({ kind: 'tool-calls', calls })
  }

  const serverContent = asRecord(frame['serverContent'])
  if (serverContent) {
    const output = asRecord(serverContent['outputTranscription'])
    if (typeof output?.['text'] === 'string' && output['text'].length > 0) {
      events.push({ kind: 'assistant-transcript', text: output['text'] })
    }
    const input = asRecord(serverContent['inputTranscription'])
    if (typeof input?.['text'] === 'string' && input['text'].length > 0) {
      events.push({ kind: 'user-transcript', text: input['text'] })
    }

    const modelTurn = asRecord(serverContent['modelTurn'])
    const parts = modelTurn?.['parts']
    if (Array.isArray(parts)) {
      for (const entry of parts) {
        const inline = asRecord(asRecord(entry)?.['inlineData'])
        const data = inline?.['data']
        if (typeof data === 'string' && data.length > 0) {
          events.push({ kind: 'audio', base64: data })
        }
      }
    }

    if (serverContent['interrupted'] === true) events.push({ kind: 'interrupted' })
    if (serverContent['turnComplete'] === true) events.push({ kind: 'turn-complete' })
  }

  if (frame['setupComplete'] !== undefined) events.push({ kind: 'setup-complete' })

  const goAway = asRecord(frame['goAway'])
  if (goAway) {
    const timeLeft = goAway['timeLeft']
    events.push({ kind: 'go-away', timeLeft: typeof timeLeft === 'string' ? timeLeft : null })
  }

  return events
}
