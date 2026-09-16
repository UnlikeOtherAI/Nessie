import { ApiErrorSchema, type ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'

export type UploadProgress = { loaded: number; total: number; pct: number }

const uploadErrorMessage = (responseText: string, fallback: string): string => {
  try {
    const parsed = ApiErrorSchema.safeParse(JSON.parse(responseText))
    if (parsed.success) return parsed.data.error.message
  } catch {
    // Non-JSON upstream errors retain their response text below.
  }
  return responseText || fallback
}

/** Thrown into the result promise when the caller aborts the upload. */
export class UploadAbortedError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'UploadAbortedError'
  }
}

export const isUploadAborted = (error: unknown): boolean =>
  error instanceof UploadAbortedError

export type UploadStart<T> = {
  /** Stops the transfer; the result promise rejects with `UploadAbortedError`. */
  abort: () => void
  result: Promise<T>
  // The request itself, for a queue that keeps a handle per entry. It is the
  // live object, not a copy: `xhr.readyState` says whether the bytes are
  // already on their way, which is the difference between "nothing happened"
  // and "a page exists on the server that has to be deleted again".
  xhr: XMLHttpRequest
}

export type UploadRequest = {
  fields?: Record<string, string>
  file: File
  // Called once when the transfer is aborted, before the result rejects.
  onAbort?: () => void
  onProgress?: (progress: UploadProgress) => void
  path: string
  token: string | null
}

// Multipart upload with real progress. `fetch` cannot report upload progress, so
// file-node / attachment uploads go through XHR and surface `upload.onprogress`.
//
// This is the form a queue uses: it hands back the request alongside the
// promise, so an entry can be cancelled mid-flight. `uploadFileWithProgress`
// below is the same call for the hosts that only ever wait for the answer.
export const startFileUpload = <T>({
  fields,
  file,
  onAbort,
  onProgress,
  path,
  token,
}: UploadRequest): UploadStart<T> => {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, value)
  }
  form.append('file', file)

  const xhr = new XMLHttpRequest()
  const result = new Promise<T>((resolve, reject) => {
    xhr.open('POST', `${getBaseUrl()}${path}`)
    if (token) {
      xhr.setRequestHeader('authorization', `Bearer ${token}`)
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          pct: Math.round((event.loaded / event.total) * 100),
        })
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const payload = JSON.parse(xhr.responseText) as ApiResponse<T>
          resolve(payload.data)
        } catch {
          reject(new Error('Malformed upload response'))
        }
        return
      }
      reject(new Error(uploadErrorMessage(xhr.responseText, `${xhr.status} ${xhr.statusText}`)))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    // `abort()` fires this, never `onerror`: a cancelled upload is not a
    // failure the queue should offer to retry with the same words.
    xhr.onabort = () => {
      onAbort?.()
      reject(new UploadAbortedError())
    }
    xhr.send(form)
  })

  return { abort: () => xhr.abort(), result, xhr }
}

export const uploadFileWithProgress = <T>(
  path: string,
  file: File,
  token: string | null,
  onProgress?: (progress: UploadProgress) => void,
  fields?: Record<string, string>,
): Promise<T> => startFileUpload<T>({ fields, file, onProgress, path, token }).result

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
