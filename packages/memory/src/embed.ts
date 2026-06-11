import type { LedgerAttribution, ModelClient } from '@nessie/runtime'

export const getEmbedding = async (
  text: string,
  client: ModelClient,
  usage?: LedgerAttribution,
): Promise<number[]> => client.embed(text, { usage })
