import type { ModelClient } from '@nessie/runtime'

export const getEmbedding = async (
  text: string,
  client: ModelClient,
): Promise<number[]> => client.embed(text)
