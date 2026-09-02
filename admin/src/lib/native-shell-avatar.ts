import { useEffect, useState } from 'react'

/**
 * A picture the native shell can render, from a picture the web app resolved.
 *
 * The native header used to be handed `me.user.avatarUrl` — the *last* source
 * in the web's precedence chain — so a person whose picture lives in
 * UnlikeOtherAI or in a local upload saw their initials in the native chrome
 * and their face in the WebView one inch below. Those two better sources are
 * authenticated byte endpoints fetched as `blob:` object URLs, and a `blob:`
 * URL belongs to this document alone: handing one to a React Native `<Image>`
 * resolves to nothing.
 *
 * So the bytes travel instead of the address. The already-fetched blob is
 * re-read as a `data:` URL, which the native side can render directly with no
 * second auth path and no second precedence chain to keep in step.
 *
 * Returns null while reading, on failure, and for a null input — the caller
 * then posts null and the native side draws initials, exactly as before.
 */
export const useDataUrl = (objectUrl: string | null): string | null => {
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!objectUrl) {
      setDataUrl(null)
      return
    }
    let cancelled = false
    fetch(objectUrl)
      .then((response) => response.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(reader.error ?? new Error('avatar read failed'))
            reader.onload = () => resolve(String(reader.result))
            reader.readAsDataURL(blob)
          }),
      )
      .then((result) => {
        if (!cancelled) setDataUrl(result)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null)
      })
    return () => {
      cancelled = true
    }
  }, [objectUrl])

  return dataUrl
}
