export type EmbeddingConfig = {
  apiKey: string
  model?: string
  baseUrl?: string
}

const DEFAULT_MODEL = 'text-embedding-3-small'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

export const getEmbedding = async (
  text: string,
  config: EmbeddingConfig,
): Promise<number[]> => {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const model = config.model ?? DEFAULT_MODEL

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text.slice(0, 8000),
      model,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Embedding API error ${response.status}: ${errorText}`)
  }

  const result = (await response.json()) as {
    data: { embedding: number[] }[]
  }

  const embedding = result.data[0]?.embedding
  if (!embedding) {
    throw new Error('No embedding returned from API')
  }

  return embedding
}
