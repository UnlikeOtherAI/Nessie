import { useEffect, useState } from 'react'
import type { ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'

export type AttachmentRecord = {
  id: string
  organizationId: string
  uploaderId?: string
  messageId?: string
  knowledgePageId?: string
  kind: string
  mime: string
  filename: string
  // BigInt on the server, serialized as a decimal string.
  sizeBytes: string
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

// Fetch a download path with the bearer token and expose it as an object URL so
// authenticated previews work (a bare <img>/<iframe> src cannot send an auth
// header). Returns null while loading, on error, or when `path` is null.
export const useAuthedObjectUrlFromPath = (
  path: string | null,
  token: string | null,
): string | null => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!path) {
      setUrl(null)
      return
    }
    let revoked = false
    let objectUrl: string | null = null
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(`${getBaseUrl()}${path}`, { headers })
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
  }, [path, token])
  return url
}

// Authenticated image/preview by attachment id (chat attachments).
export const useAuthedObjectUrl = (id: string | null, token: string | null): string | null =>
  useAuthedObjectUrlFromPath(id ? `/api/attachments/${id}` : null, token)

// Trigger a browser download of an authed path (bytes fetched with the token,
// then handed to a transient <a download> link).
export const downloadAuthedPath = async (
  path: string,
  filename: string,
  token: string | null,
): Promise<void> => {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  const res = await fetch(`${getBaseUrl()}${path}`, { headers })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const blob = await res.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}
