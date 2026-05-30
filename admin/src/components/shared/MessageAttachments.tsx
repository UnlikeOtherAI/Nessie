import { useEffect, useState } from 'react'
import type { ApiResponse } from '@nessie/schemas'
import { getBaseUrl } from '../../lib/api-client'
import { attachmentUrl, type AttachmentRecord } from '../../lib/uploads'
import { useAuthSession } from '../../providers/AuthSessionProvider'

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Fetch attachment bytes with the bearer token and expose them as an object URL
// so authenticated images/downloads work (a bare <img src> cannot send auth).
const useAuthedObjectUrl = (id: string, token: string | null, enabled: boolean): string | null => {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!enabled) return
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
  }, [id, token, enabled])
  return url
}

const ImageAttachment = ({
  attachment,
  token,
}: {
  attachment: AttachmentRecord
  token: string | null
}) => {
  const url = useAuthedObjectUrl(attachment.id, token, true)
  if (!url) {
    return <DownloadChip attachment={attachment} token={token} />
  }
  return (
    <img
      alt={attachment.filename}
      className="max-h-80 max-w-full rounded-md border border-[color:var(--sep)]"
      src={url}
    />
  )
}

const DownloadChip = ({
  attachment,
  token,
}: {
  attachment: AttachmentRecord
  token: string | null
}) => {
  const [downloading, setDownloading] = useState(false)
  const handleDownload = () => {
    setDownloading(true)
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(attachmentUrl(attachment.id), { headers })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = objectUrl
        link.download = attachment.filename
        link.click()
        URL.revokeObjectURL(objectUrl)
      })
      .finally(() => setDownloading(false))
  }
  return (
    <button
      className={[
        'inline-flex items-center gap-2 rounded-md border',
        'border-[color:var(--sep)] bg-black/20 px-3 py-2',
        'text-xs text-[color:var(--tx2)] hover:bg-white/5',
      ].join(' ')}
      disabled={downloading}
      onClick={handleDownload}
      type="button"
    >
      <span className="font-semibold text-white">{attachment.filename}</span>
      <span>{formatBytes(attachment.sizeBytes)}</span>
      <span>{downloading ? '…' : '↓'}</span>
    </button>
  )
}

export const MessageAttachments = ({ messageId }: { messageId: string }) => {
  const { token } = useAuthSession()
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([])

  useEffect(() => {
    let cancelled = false
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    fetch(`${getBaseUrl()}/api/messages/${messageId}/attachments`, { headers })
      .then((res) =>
        res.ok ? (res.json() as Promise<ApiResponse<AttachmentRecord[]>>) : Promise.reject(),
      )
      .then((payload) => {
        if (!cancelled) setAttachments(payload.data)
      })
      .catch(() => {
        if (!cancelled) setAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [messageId, token])

  if (attachments.length === 0) return null

  return (
    <div className="mt-2 flex flex-col gap-2">
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <ImageAttachment attachment={attachment} key={attachment.id} token={token} />
        ) : (
          <DownloadChip attachment={attachment} key={attachment.id} token={token} />
        ),
      )}
    </div>
  )
}
