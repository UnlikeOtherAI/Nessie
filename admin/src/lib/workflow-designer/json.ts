export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const readRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {}

export const formatJson = (value: unknown) =>
  JSON.stringify(value ?? {}, null, 2)

export const readJsonObject = (value: string): Record<string, unknown> | null => {
  if (!value.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
