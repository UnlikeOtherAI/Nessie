import { useState, type ReactNode } from 'react'
import { useAuthedTextFromPath } from '../../lib/uploads'
import { QueryState } from './QueryState'

/**
 * Reads a stored text file with the session token and hands its content to a
 * caller-supplied renderer.
 *
 * Attachment bytes need an `Authorization` header and are cross-origin from
 * the admin (`app.` versus `api.`), so a bare `<a href>`/`<iframe src>` fetches
 * nothing — every text preview goes through the authed fetch in
 * `useAuthedTextFromPath`. The renderer decides how it looks: knowledge files
 * render markdown or a `<pre>`, the voice call record renders its transcript.
 *
 * That hook fetches on mount and has no `refetch` of its own — Retry here works
 * by discarding this body and mounting a fresh one (a new `key` from
 * {@link RetryableTextFilePreview}), which re-runs the fetch exactly like a
 * first load.
 */
export const TextFilePreview = ({
  downloadPath,
  onRetry,
  render,
  token,
}: {
  downloadPath: string
  onRetry: () => void
  render: (state: { text: string; truncated: boolean }) => ReactNode
  token: string | null
}) => {
  const textPreview = useAuthedTextFromPath(downloadPath, token)
  return (
    <QueryState
      className="py-12"
      errorLabel="Preview unavailable."
      loadingLabel="Loading preview…"
      query={{ isError: textPreview.error, isLoading: textPreview.loading, refetch: onRetry }}
    >
      {() => render({ text: textPreview.text ?? '', truncated: textPreview.truncated })}
    </QueryState>
  )
}

export const RetryableTextFilePreview = (
  props: Omit<Parameters<typeof TextFilePreview>[0], 'onRetry'>,
) => {
  const [retryKey, setRetryKey] = useState(0)
  return (
    <TextFilePreview
      key={retryKey}
      {...props}
      onRetry={() => setRetryKey((value) => value + 1)}
    />
  )
}
