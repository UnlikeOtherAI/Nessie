import { Readable } from 'node:stream'

import type { CdpClient } from '@nessie/browser-cloud'
import { attributionFromActorContext } from '@nessie/runtime'

import { fileServiceFor } from '../file-service.js'
import type { BuiltinToolRuntimeContext } from '../tool-types.js'
import { originIsAuthenticated, type OriginGateState } from './origin-gate.js'

/**
 * `browser_download` — take a file out of the browser and into the workspace.
 *
 * The bytes are fetched *from inside the page*, which is the only way a file
 * behind a sign-in can be read at all: the request carries the session's own
 * cookies. That means running our own script in the page, which the closed
 * verb grammar otherwise excludes — the distinction that matters is that the
 * script is ours and fixed, and the model supplies only a node id.
 *
 * Everything lands through the one `FileService`, so the download is
 * accounted, quota-gated and thumbnailed exactly like any upload.
 */

/** Big enough for reports and exports, small enough not to bloat a run. */
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024

type DownloadOutcome = { output: string; success: boolean }

const filenameFrom = (url: string, disposition: string | null): string => {
  const fromDisposition = disposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)?.[1]
  if (fromDisposition) return decodeURIComponent(fromDisposition).slice(0, 200)
  try {
    const path = new URL(url).pathname
    const last = path.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last).slice(0, 200)
  } catch {
    // fall through
  }
  return 'download'
}

/**
 * Resolve a node's link target. The model addresses a node id, exactly as it
 * does for click and type — it never hands us a URL to fetch, which is what
 * keeps this from becoming a general-purpose fetch with the browser's cookies.
 */
const hrefForNode = async (cdp: CdpClient, nodeId: number): Promise<string | null> => {
  const described = await cdp.call('DOM.describeNode', { backendNodeId: nodeId })
  const node = described.node as { attributes?: unknown } | undefined
  const attributes = Array.isArray(node?.attributes) ? node.attributes : []
  for (let index = 0; index < attributes.length; index += 2) {
    if (attributes[index] === 'href' || attributes[index] === 'src') {
      const value = attributes[index + 1]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return null
}

export const downloadFromBrowser = async (
  cdp: CdpClient,
  context: BuiltinToolRuntimeContext,
  input: { nodeId: number; gate: OriginGateState | null },
): Promise<DownloadOutcome> => {
  const href = await hrefForNode(cdp, input.nodeId)
  if (!href) {
    return {
      output: 'That element has no link to download. Pick a link or image node.',
      success: false,
    }
  }

  const resolved = await cdp.call('Runtime.evaluate', {
    awaitPromise: true,
    expression: `new URL(${JSON.stringify(href)}, document.baseURI).toString()`,
    returnByValue: true,
  })
  const absolute = (resolved.result as { value?: unknown } | undefined)?.value
  if (typeof absolute !== 'string') {
    return { output: 'That link could not be resolved.', success: false }
  }
  if (!absolute.startsWith('https://')) {
    return { output: 'Only https downloads are allowed.', success: false }
  }

  // A signed-in browser must not be used to pull bytes off an unrelated
  // origin: that is the same exfiltration shape the write gate refuses,
  // pointed the other way.
  if (input.gate?.touchedAuthenticated) {
    try {
      const origin = new URL(absolute).origin
      if (!originIsAuthenticated(origin, input.gate.authenticatedOrigins)) {
        return {
          output:
            `This browser is signed in elsewhere, and ${origin} is not one of those `
            + 'sites. Downloading from it is blocked.',
          success: false,
        }
      }
    } catch {
      return { output: 'That link could not be read.', success: false }
    }
  }

  const fetched = await cdp.call('Runtime.evaluate', {
    awaitPromise: true,
    expression: `(async () => {
      const response = await fetch(${JSON.stringify(absolute)}, { credentials: 'include' })
      if (!response.ok) return { error: 'status ' + response.status }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > ${MAX_DOWNLOAD_BYTES}) return { error: 'too large' }
      let binary = ''
      const bytes = new Uint8Array(buffer)
      for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index])
      }
      return {
        base64: btoa(binary),
        mime: response.headers.get('content-type') || 'application/octet-stream',
        disposition: response.headers.get('content-disposition'),
      }
    })()`,
    returnByValue: true,
  })

  const value = (fetched.result as { value?: unknown } | undefined)?.value as {
    base64?: unknown
    mime?: unknown
    disposition?: unknown
    error?: unknown
  } | undefined

  if (!value || typeof value.base64 !== 'string') {
    const reason = typeof value?.error === 'string' ? value.error : 'the page refused it'
    return { output: `That file could not be downloaded (${reason}).`, success: false }
  }

  const bytes = Buffer.from(value.base64, 'base64')
  if (bytes.byteLength === 0) {
    return { output: 'That download was empty.', success: false }
  }

  const mime = typeof value.mime === 'string' ? value.mime.split(';')[0]!.trim() : 'application/octet-stream'
  const filename = filenameFrom(absolute, typeof value.disposition === 'string' ? value.disposition : null)

  const { attachment } = await fileServiceFor(context.prisma).store({
    attribution: attributionFromActorContext(context.actorContext),
    body: Readable.from(bytes),
    filename,
    mime,
    organizationId: context.channel.organizationId,
    uploaderId: context.run.principalUserId ?? null,
  })

  return {
    output: [
      `Downloaded ${attachment.filename} (${attachment.mime}, ${attachment.sizeBytes} bytes).`,
      `attachment id=${attachment.id} — link it with send_message attachmentIds.`,
    ].join('\n'),
    success: true,
  }
}
