import { Readable } from 'node:stream'

import { renderImageThumbnail, safeFetch, type StoreFileInput } from '@nessie/runtime'
import { z } from 'zod'

import { normalizeEndpoint } from './registry-mapper.js'
import { sniffImageMime, type IconFetch, type IconFileService, type RegistryIconResult } from './registry-icons.js'

/** Provenance for a cached icon declared in an MCP repository bundle. */
export const REPOSITORY_ICON_SOURCE = 'mcp_repository'

const MAX_ASSET_BYTES = 512 * 1024
const FETCH_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 2

type GitHubRepository = { owner: string; repository: string }

const GitHubMetadataSchema = z.object({ default_branch: z.string().min(1).max(200) })

const McpServerSchema = z.object({
  url: z.string().min(1),
  _meta: z.object({ ideToolIconPath: z.string().min(1).max(500) }).optional(),
})

const McpDescriptorSchema = z.object({ mcpServers: z.record(McpServerSchema) })

/** The narrow storage seam, kept injectable so fetching never reaches tests. */
export type RepositoryIconCacher = (input: {
  displayName: string
  endpointUrl: string
  repositoryUrl: string | null
}) => Promise<RegistryIconResult | null>

export type RepositoryIconCacheContext = {
  fileService: IconFileService
  organizationId: string
  actorId: string
  fetch?: IconFetch
}

const validRepositorySegment = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)

/** A repository URL is data, not a fetch target; only canonical GitHub repos work here. */
const parseGitHubRepository = (repositoryUrl: string | null): GitHubRepository | null => {
  if (!repositoryUrl) return null
  try {
    const url = new URL(repositoryUrl)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
    if (url.search || url.hash) return null
    const [owner, rawRepository, ...rest] = url.pathname.split('/').filter(Boolean)
    const repository = rawRepository?.replace(/\.git$/i, '')
    if (rest.length > 0 || !owner || !repository) return null
    if (!validRepositorySegment(owner) || !validRepositorySegment(repository)) return null
    return { owner, repository }
  } catch {
    return null
  }
}

/** Reject a path escape before it is made part of a raw GitHub URL. */
const encodeRepositoryPath = (input: string): string | null => {
  if (!input.startsWith('./') || input.includes('\\') || input.includes('\0')) return null
  const segments = input.slice(2).split('/')
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return null
  }
  return segments.map(encodeURIComponent).join('/')
}

const readCapped = async (response: Response, controller: AbortController): Promise<Buffer | null> => {
  if (!response.ok || !response.body) return null
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_BYTES) return null

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_ASSET_BYTES) {
      controller.abort()
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks, total)
}

const fetchBytes = async (url: string, fetch: IconFetch): Promise<Buffer | null> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  timeout.unref?.()
  try {
    return await readCapped(await fetch(url, { signal: controller.signal }), controller)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * The repository descriptor can name several MCP servers. Only use an asset
 * from the exact server whose canonical endpoint matches the registry entry.
 */
const iconPathFromDescriptor = (descriptor: Buffer, endpointUrl: string): string | null => {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(descriptor.toString('utf8'))
  } catch {
    return null
  }
  const parsed = McpDescriptorSchema.safeParse(parsedJson)
  if (!parsed.success) return null
  for (const server of Object.values(parsed.data.mcpServers)) {
    if (normalizeEndpoint(server.url) !== endpointUrl) continue
    const path = server._meta?.ideToolIconPath
    if (path) return encodeRepositoryPath(path)
  }
  return null
}

/**
 * SVG becomes a WebP before storage. The small structural refusal list leaves
 * only static shapes for librsvg: no script, entity, external reference, or
 * CSS URL is ever interpreted. The buffer input also prevents file reads.
 */
const renderSafeSvg = async (bytes: Buffer): Promise<Buffer | null> => {
  const source = bytes.toString('utf8')
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source)) return null
  const unsafeMarkup = [
    /<!DOCTYPE/i,
    /<!ENTITY/i,
    /<\/?(?:script|foreignObject|image|iframe|object|embed|use|animate|set)\b/i,
    /(?:xlink:)?href\s*=/i,
    /url\s*\(/i,
  ]
  if (unsafeMarkup.some((pattern) => pattern.test(source))) {
    return null
  }
  return (await renderImageThumbnail(bytes, { vector: true }))?.data ?? null
}

const iconFilename = (displayName: string, extension: 'jpg' | 'png' | 'webp'): string => {
  const base = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${base || 'app'}-icon.${extension}`
}

const storeIcon = async (params: {
  bytes: Buffer
  displayName: string
  extension: 'jpg' | 'png' | 'webp'
  fileService: IconFileService
  mime: 'image/jpeg' | 'image/png' | 'image/webp'
  organizationId: string
  actorId: string
}): Promise<RegistryIconResult | null> => {
  const input: StoreFileInput = {
    attribution: { organizationId: params.organizationId, actorId: params.actorId },
    body: Readable.from(params.bytes),
    filename: iconFilename(params.displayName, params.extension),
    mime: params.mime,
    organizationId: params.organizationId,
    uploaderId: params.actorId,
  }
  try {
    const { attachment } = await params.fileService.store(input)
    return { attachmentId: attachment.id, source: REPOSITORY_ICON_SOURCE }
  } catch {
    return null
  }
}

const safeRepositoryFetch: IconFetch = (url, init) =>
  safeFetch(
    url,
    { method: 'GET', redirect: 'follow', signal: init.signal },
    { maxRedirects: MAX_REDIRECTS },
  )

/**
 * Resolve `ideToolIconPath` the same way an IDE does: from `.mcp.json` and
 * relative to the same GitHub repository. Nothing from a repository reaches a
 * browser; the only persisted result is a MIME-checked raster attachment.
 */
export const cacheRepositoryIcon = async (params: {
  displayName: string
  endpointUrl: string
  repositoryUrl: string | null
  fileService: IconFileService
  organizationId: string
  actorId: string
  fetch: IconFetch
}): Promise<RegistryIconResult | null> => {
  const repository = parseGitHubRepository(params.repositoryUrl)
  if (!repository) return null
  const base = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}`
  const metadataBytes = await fetchBytes(base, params.fetch)
  if (!metadataBytes) return null
  let metadataJson: unknown
  try {
    metadataJson = JSON.parse(metadataBytes.toString('utf8'))
  } catch {
    return null
  }
  const metadata = GitHubMetadataSchema.safeParse(metadataJson)
  if (!metadata.success) return null

  const rawBase = `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repository)}/${encodeURIComponent(metadata.data.default_branch)}`
  const descriptor = await fetchBytes(`${rawBase}/.mcp.json`, params.fetch)
  if (!descriptor) return null
  const iconPath = iconPathFromDescriptor(descriptor, params.endpointUrl)
  if (!iconPath) return null

  const asset = await fetchBytes(`${rawBase}/${iconPath}`, params.fetch)
  if (!asset) return null
  const source = asset.toString('utf8')
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source)) {
    const raster = await renderSafeSvg(asset)
    if (!raster) return null
    return storeIcon({ ...params, bytes: raster, extension: 'webp', mime: 'image/webp' })
  }

  const mime = sniffImageMime(asset)
  if (!mime) return null
  return storeIcon({
    ...params,
    bytes: asset,
    extension: mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp',
    mime,
  })
}

export const createRepositoryIconCacher = (context: RepositoryIconCacheContext): RepositoryIconCacher => {
  const fetch = context.fetch ?? safeRepositoryFetch
  return (input) => cacheRepositoryIcon({ ...input, ...context, fetch })
}
