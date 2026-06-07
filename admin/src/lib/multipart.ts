import type { ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'

// Multipart PUT helper. The shared JSON ApiClient cannot send FormData, so
// credential uploads PUT with a raw fetch carrying the bearer token, a single
// file part, and any text fields. Mirrors lib/uploads.ts but for PUT.
export const putMultipart = async <TData>(
  path: string,
  file: File,
  fields: Record<string, string>,
  token: string | null,
): Promise<TData> => {
  const form = new FormData()
  form.append('file', file)
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value)
  }

  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${getBaseUrl()}${path}`, {
    body: form,
    headers,
    method: 'PUT',
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as ApiResponse<TData>
  return payload.data
}
