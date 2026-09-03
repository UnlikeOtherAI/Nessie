import { useEffect, useState } from 'react'
import type { ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'
import {
  blobCacheKey,
  peekBlobUrl,
  releaseBlobUrl,
  retainBlobUrl,
  storeBlobUrl,
} from './blob-cache'

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
  // Small WebP preview at /api/attachments/:id/thumbnail. Absent for
  // attachments stored before thumbnails existed (never backfilled) and for
  // kinds with no preview — render the original or a download chip instead.
  hasThumbnail?: boolean
  thumbnailStatus?: 'pending' | 'ready' | 'unavailable'
  thumbnailMime?: string
  thumbnailSizeBytes?: string
  thumbnailWidth?: number
  thumbnailHeight?: number
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

// Multipart PUT of an UnlikeOtherAI-hosted avatar — the team ("company")
// picture or the signed-in person's own profile photo. Like uploadAttachment
// this bypasses the JSON ApiClient because it cannot send FormData; unlike it,
// the bytes are relayed straight to UnlikeOtherAI and never stored by Nessie.
const uploadRelayedAvatar = async (
  path: string,
  file: File,
  token: string | null,
): Promise<void> => {
  const form = new FormData()
  form.append('file', file)

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
    const payload = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null
    throw new Error(
      payload?.error?.message || `${response.status} ${response.statusText}`,
    )
  }
}

export const uploadTeamAvatar = (file: File, token: string | null): Promise<void> =>
  uploadRelayedAvatar('/api/team/avatar', file, token)

/** Replace the signed-in person's UnlikeOtherAI-hosted profile photo. */
export const uploadMyUoaAvatar = (file: File, token: string | null): Promise<void> =>
  uploadRelayedAvatar('/api/auth/me/avatar/uoa', file, token)

// URL the browser can use to fetch attachment bytes (image preview / download).
export const attachmentUrl = (id: string): string => `${getBaseUrl()}/api/attachments/${id}`

// Paths (not absolute URLs) for the authed-fetch hooks below.
export const attachmentPath = (id: string): string => `/api/attachments/${id}`
export const attachmentThumbnailPath = (id: string): string =>
  `/api/attachments/${id}/thumbnail`

// Fetch a download path with the bearer token and expose it as an object URL so
// authenticated previews work (a bare <img>/<iframe> src cannot send an auth
// header). Returns null while loading, on error, or when `path` is null.
//
// Bytes come from the shared blob cache (`lib/blob-cache.ts`), so a face that
// was on screen a second ago — a retained layer coming back, the same avatar in
// a second place — paints on the first frame instead of re-fetching. A cache
// hit is read synchronously during the initial render, never in an effect,
// which is what makes it show immediately rather than one paint late.
export const useAuthedObjectUrlFromPath = (
  path: string | null,
  token: string | null,
  mimeOverride?: string,
): string | null => {
  const cacheKey = path ? blobCacheKey(path, mimeOverride) : null
  // The resolved URL carries the key it belongs to, so a key change reads as a
  // miss on the very render it happens rather than one effect later — that gap
  // is how an <img> ends up showing the previous path's bytes.
  const [resolved, setResolved] = useState<{ key: string; url: string } | null>(null)
  useEffect(() => {
    if (!cacheKey || !path) {
      setResolved(null)
      return
    }
    const setUrl = (next: string | null) =>
      setResolved(next === null ? null : { key: cacheKey, url: next })
    const cached = retainBlobUrl(cacheKey)
    if (cached) {
      setUrl(cached)
      return () => releaseBlobUrl(cacheKey)
    }
    let cancelled = false
    let held = false
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(`${getBaseUrl()}${path}`, { headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        // A blob: URL inherits the admin origin, so the blob's MIME type drives
        // how an <iframe> renders it. The server echoes the upload's (attacker-
        // controllable) content-type, so trusting it here would let an uploaded
        // text/html file named "x.pdf" execute scripts in this session. When the
        // caller knows the safe type, pin it (zero-copy re-type via slice).
        const typed = mimeOverride ? blob.slice(0, blob.size, mimeOverride) : blob
        // Store even when this hook has been torn down: the bytes are paid for,
        // and the store's own reference is released immediately below so the
        // entry is evictable.
        const shared = storeBlobUrl(cacheKey, URL.createObjectURL(typed))
        if (cancelled) {
          releaseBlobUrl(cacheKey)
          return
        }
        held = true
        setUrl(shared)
      })
      .catch(() => {
        if (!cancelled) setUrl(null)
      })
    return () => {
      cancelled = true
      // The URL is not revoked here — the cache owns its lifetime and revokes
      // on eviction. Clearing the state matters all the same: a dep change
      // must not leave an <img> pointing at the previous path's bytes.
      if (held) releaseBlobUrl(cacheKey)
      setResolved(null)
    }
  }, [cacheKey, path, token, mimeOverride])
  if (!cacheKey) return null
  if (resolved?.key === cacheKey) return resolved.url
  // A hit is available before the effect runs, so the first paint already has
  // it; the effect then takes the reference that keeps it alive.
  return peekBlobUrl(cacheKey)
}

export type AuthedTextState = {
  text: string | null
  truncated: boolean
  loading: boolean
  error: boolean
}

// Fetch a text file's content with the bearer token for an inline plain-text
// preview, capped so a huge "text" file can't lock the tab.
export const useAuthedTextFromPath = (
  path: string | null,
  token: string | null,
  maxBytes = 512 * 1024,
): AuthedTextState => {
  const [state, setState] = useState<AuthedTextState>({
    text: null,
    truncated: false,
    loading: Boolean(path),
    error: false,
  })
  useEffect(() => {
    if (!path) {
      setState({ text: null, truncated: false, loading: false, error: false })
      return
    }
    let cancelled = false
    setState({ text: null, truncated: false, loading: true, error: false })
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(`${getBaseUrl()}${path}`, { headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then(async (blob) => {
        const truncated = blob.size > maxBytes
        const text = await (truncated ? blob.slice(0, maxBytes) : blob).text()
        if (!cancelled) setState({ text, truncated, loading: false, error: false })
      })
      .catch(() => {
        if (!cancelled) setState({ text: null, truncated: false, loading: false, error: true })
      })
    return () => {
      cancelled = true
    }
  }, [path, token, maxBytes])
  return state
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
