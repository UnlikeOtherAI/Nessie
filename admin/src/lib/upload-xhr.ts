import type { ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from './api-client'

export type UploadProgress = { loaded: number; total: number; pct: number }

// Multipart upload with real progress. `fetch` cannot report upload progress, so
// file-node / attachment uploads go through XHR and surface `upload.onprogress`.
export const uploadFileWithProgress = <T>(
  path: string,
  file: File,
  token: string | null,
  onProgress?: (progress: UploadProgress) => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)

    const xhr = new XMLHttpRequest()
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
      reject(new Error(xhr.responseText || `${xhr.status} ${xhr.statusText}`))
    }
    xhr.onerror = () => reject(new Error('Upload failed'))
    xhr.send(form)
  })

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** exponent
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}
