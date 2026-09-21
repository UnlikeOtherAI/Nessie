import { useEffect, useState } from 'react'
import { INLINE_ATTACHMENT_PATH } from '@nessie/schemas'
import { getBaseUrl } from '../../lib/api-client'
import {
  blobCacheKey,
  peekBlobUrl,
  releaseBlobUrl,
  retainBlobUrl,
  storeBlobUrl,
} from '../../lib/blob-cache'
import { useOptionalAuthSession } from '../../providers/AuthSessionProvider'

export type AuthedImageStatus = 'loading' | 'ready' | 'missing' | 'error'

/** True for the one inline-image form: `/api/attachments/<uuid>`. */
export const isInlineAttachmentSrc = (src: string | null | undefined): src is string =>
  typeof src === 'string' && INLINE_ATTACHMENT_PATH.test(src)

/**
 * `useAuthedObjectUrlFromPath` with the outcome kept.
 *
 * That hook answers `null` for "still loading" and for "failed" alike, which is
 * right for an avatar and wrong here: a description image whose file was
 * removed must say *Image removed*, not shimmer forever. Bytes go through the
 * same shared blob cache, under the same key, so an image already fetched by
 * the other hook (an attachment row's preview) paints on the first frame and
 * vice versa.
 */
export const useAuthedImage = (
  path: string | null,
  token: string | null,
): { status: AuthedImageStatus; url: string | null } => {
  const cacheKey = path ? blobCacheKey(path) : null
  const [state, setState] = useState<{ key: string; status: AuthedImageStatus; url: string | null } | null>(null)

  useEffect(() => {
    if (!cacheKey || !path) {
      setState(null)
      return undefined
    }
    const cached = retainBlobUrl(cacheKey)
    if (cached) {
      setState({ key: cacheKey, status: 'ready', url: cached })
      return () => releaseBlobUrl(cacheKey)
    }
    let cancelled = false
    let held = false
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(`${getBaseUrl()}${path}`, { headers })
      .then(async (response) => {
        if (!response.ok) {
          if (!cancelled) {
            setState({
              key: cacheKey,
              status: response.status === 404 || response.status === 410 ? 'missing' : 'error',
              url: null,
            })
          }
          return
        }
        const blob = await response.blob()
        const shared = storeBlobUrl(cacheKey, URL.createObjectURL(blob))
        if (cancelled) {
          releaseBlobUrl(cacheKey)
          return
        }
        held = true
        setState({ key: cacheKey, status: 'ready', url: shared })
      })
      .catch(() => {
        if (!cancelled) setState({ key: cacheKey, status: 'error', url: null })
      })
    return () => {
      cancelled = true
      if (held) releaseBlobUrl(cacheKey)
      setState(null)
    }
  }, [cacheKey, path, token])

  if (!cacheKey) return { status: 'error', url: null }
  if (state?.key === cacheKey) return { status: state.status, url: state.url }
  const peeked = peekBlobUrl(cacheKey)
  return peeked ? { status: 'ready', url: peeked } : { status: 'loading', url: null }
}

type AuthedAttachmentImageProps = {
  alt?: string
  className?: string
  /** `/api/attachments/<id>` — the inline-image form. */
  src: string
}

/**
 * An inline image stored as a ticket attachment. The `<img>` only ever gets
 * the `blob:` URL: the API path needs a bearer token a bare `src` cannot send,
 * and putting it there would also leak the path into the page for no gain.
 */
export const AuthedAttachmentImage = ({ alt, className, src }: AuthedAttachmentImageProps) => {
  const token = useOptionalAuthSession()?.token ?? null
  const { status, url } = useAuthedImage(isInlineAttachmentSrc(src) ? src : null, token)
  if (status === 'ready' && url) {
    return (
      <img
        alt={alt ?? ''}
        className={['admin-attachment-image', className].filter(Boolean).join(' ')}
        data-attachment-src={src}
        loading="lazy"
        src={url}
      />
    )
  }
  if (status === 'loading') {
    // A span, not `SkeletonBlock`'s div: a Markdown image sits inside a `<p>`,
    // where a block element is invalid. The box is the skeleton's own token.
    return (
      <span
        aria-label={alt || 'Image loading'}
        className="admin-attachment-image-loading"
        data-attachment-src={src}
        role="img"
      />
    )
  }
  return (
    <span
      className="admin-attachment-image-missing"
      data-attachment-src={src}
      data-testid="attachment-image-missing"
    >
      <span aria-hidden="true">🖼</span>
      <span className="min-w-0 truncate">
        {status === 'missing' ? 'Image removed' : `${alt?.trim() || 'Image'} — could not load`}
      </span>
    </span>
  )
}
