import type {
  InvocationUsage,
  NormalizedFinishReason,
  ProviderStreamEvent,
  ProviderToolCall,
} from '../types.js'

export type CapturedStreamResult = {
  finishReason?: NormalizedFinishReason
  outputText: string
  toolCalls: ProviderToolCall[]
  usage: InvocationUsage
}

export type ProviderStreamCapture = AsyncGenerator<
  ProviderStreamEvent,
  CapturedStreamResult,
  undefined
>

// Safety net: if a streaming response is abandoned and the generator is GC'd
// before completion, FinalizationRegistry ensures the reader is cancelled and
// released back to the connection pool, preventing socket leaks.
// See: openclaw/openclaw#67461
const streamFinalizationRegistry = new FinalizationRegistry<ReadableStreamDefaultReader>(
  (reader) => {
    reader.cancel().catch(() => { /* ignore cancel errors on already-resolved streams */ })
    reader.releaseLock()
  },
)

export const registerStreamReaderCleanup = (
  reader: ReadableStreamDefaultReader,
): object => {
  const cleanupToken: object = {}
  streamFinalizationRegistry.register(cleanupToken, reader, cleanupToken)
  return cleanupToken
}

export const releaseStreamReader = async (
  reader: ReadableStreamDefaultReader,
  cleanupToken: object,
): Promise<void> => {
  streamFinalizationRegistry.unregister(cleanupToken)
  await reader.cancel().catch(() => { /* ignore cancel errors */ })
  reader.releaseLock()
}
