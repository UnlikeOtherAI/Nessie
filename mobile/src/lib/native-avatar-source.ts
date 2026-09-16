/**
 * Loads the pictures the native chrome draws itself (the team mark and the
 * signed-in person) and keeps them current after an upload.
 *
 * Replacing a team avatar keeps its URL: UOA serves every version at
 * `/teams/:teamId/avatar?size=128`, marked `private, max-age=300`. The web app
 * cache-busts its own relay with `?v=<revision>`, but UOA's public route rejects
 * any query field it does not know, so the native chrome cannot do the same.
 * Instead every load revalidates against the server with `If-None-Match`, which
 * is also the one request header that makes React Native's iOS networking skip
 * the local URL cache (`RCTNetworking.mm`); without it the old image was served
 * from that cache indefinitely.
 *
 * The bytes that came back are drawn as a data URI rather than handed to
 * `<Image>` by URL, because the image loader keeps a second cache of its own
 * keyed by the same unchanged URL.
 */

export type AvatarImageSource =
  | { kind: 'fallback' }
  | { kind: 'raster'; uri: string }
  | { kind: 'svg'; xml: string }

type CachedAvatar = { etag: string | null; source: AvatarImageSource }

type AvatarFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Pick<Response, 'arrayBuffer' | 'headers' | 'ok' | 'status' | 'text'>>

// Sent before an ETag is known. It never matches, so the server always answers
// with the image, but its presence still bypasses the stale local cache.
const UNKNOWN_ETAG = '"nessie-native-avatar-unknown"'

const loaded = new Map<string, CachedAvatar>()
const listeners = new Set<() => void>()
let refreshGeneration = 0

/** Ask every mounted native avatar to revalidate its picture. */
export const requestNativeAvatarRefresh = (): void => {
  refreshGeneration += 1
  for (const listener of listeners) listener()
}

export const subscribeNativeAvatarRefresh = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const nativeAvatarRefreshGeneration = (): number => refreshGeneration

/** The last picture loaded for a URL, so a remount paints it immediately. */
export const lastLoadedNativeAvatar = (url: string): AvatarImageSource | null =>
  loaded.get(url)?.source ?? null

const contentType = (headers: Headers): string =>
  headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''

const base64FromBytes = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

export const loadNativeAvatar = async (
  url: string,
  options: { fetchImpl?: AvatarFetch; signal?: AbortSignal } = {},
): Promise<AvatarImageSource> => {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as AvatarFetch)
  const previous = loaded.get(url)
  const response = await fetchImpl(url, {
    headers: { 'If-None-Match': previous?.etag ?? UNKNOWN_ETAG },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (response.status === 304 && previous) return previous.source
  if (!response.ok) throw new Error(`Avatar request failed: ${response.status}`)

  const type = contentType(response.headers)
  let source: AvatarImageSource
  if (type === 'image/svg+xml') {
    const xml = await response.text()
    if (!xml.trim()) throw new Error('Avatar SVG is empty')
    source = { kind: 'svg', xml }
  } else {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength === 0) throw new Error('Avatar image is empty')
    const mime = type.startsWith('image/') ? type : 'image/png'
    source = { kind: 'raster', uri: `data:${mime};base64,${base64FromBytes(bytes)}` }
  }
  loaded.set(url, { etag: response.headers.get('etag'), source })
  return source
}

/** Test seam: forget every loaded picture. */
export const resetNativeAvatarCache = (): void => {
  loaded.clear()
}
