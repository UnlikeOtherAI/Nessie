import { useEffect, useState } from 'react'
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

// Fetch attachment bytes with the bearer token and expose them as an object URL
// so authenticated images work (a bare <img src> cannot send an auth header).
// Returns null while loading, on error, or when `id` is null.
export const useAuthedObjectUrl = (id: string | null, token: string | null): string | null => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!id) {
      setUrl(null)
      return
    }
    let revoked = false
    let objectUrl: string | null = null
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(attachmentUrl(id), { headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => setUrl(null))
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [id, token])
  return url
}
