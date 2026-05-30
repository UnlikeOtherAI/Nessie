import type { ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'

export type AttachmentRecord = {
  id: string
  organizationId: string
  uploaderId?: string
  messageId?: string
  kind: string
  mime: string
  filename: string
  sizeBytes: number
  width?: number
  height?: number
  createdAt: string
}

// Multipart upload helper. The shared JSON ApiClient cannot send FormData, so
// attachments POST to /api/uploads with a raw fetch carrying the bearer token.
export const uploadAttachment = async (
  file: File,
  token: string | null,
): Promise<AttachmentRecord> => {
  const form = new FormData()
  form.append('file', file)

  const headers = new Headers()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }

  const response = await fetch(`${getBaseUrl()}/api/uploads`, {
    body: form,
    headers,
    method: 'POST',
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as ApiResponse<AttachmentRecord>
  return payload.data
}

// URL the browser can use to fetch attachment bytes (image preview / download).
export const attachmentUrl = (id: string): string => `${getBaseUrl()}/api/attachments/${id}`
