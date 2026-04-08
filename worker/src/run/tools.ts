import { lookup } from 'node:dns/promises'
import { readFile, readdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type ToolExecutionResult = {
  inputSummary: string
  outputPreview: string
  toolName: string
}

const MAX_PREVIEW_LENGTH = 1200
const URL_PATTERN = /https?:\/\/[^\s)]+/i
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const docsRoot = resolve(repoRoot, 'docs')
const docsRootPrefix = `${docsRoot}${sep}`
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'host.docker.internal',
  'gateway.docker.internal',
  'metadata.google.internal',
])

const truncate = (value: string, maxLength = MAX_PREVIEW_LENGTH): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`

const extractUrl = (prompt: string): string | null => {
  const rawMatch = prompt.match(URL_PATTERN)?.[0]
  if (!rawMatch) {
    return null
  }

  return rawMatch.replace(/[.,!?;:]+$/, '')
}

const stripHtml = (value: string): string =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

const collectMarkdownFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        return collectMarkdownFiles(fullPath)
      }

      return entry.name.endsWith('.md') ? [fullPath] : []
    }),
  )

  return files.flat()
}

const resolveDocsPath = (candidatePath: string): string | null => {
  const resolvedPath = resolve(repoRoot, candidatePath)
  return resolvedPath === docsRoot || resolvedPath.startsWith(docsRootPrefix)
    ? resolvedPath
    : null
}

const selectDocumentPath = async (prompt: string): Promise<string | null> => {
  const explicitPathMatch = prompt.match(/\bdocs\/[A-Za-z0-9._/-]+\.md\b/)
  if (explicitPathMatch) {
    return resolveDocsPath(explicitPathMatch[0])
  }

  const files = await collectMarkdownFiles(docsRoot)
  if (files.length === 0) {
    return null
  }

  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)

  const ranked = files
    .map((filePath) => {
      const haystack = filePath.toLowerCase()
      const score = tokens.reduce(
        (current, token) => current + (haystack.includes(token) ? 1 : 0),
        0,
      )

      return { filePath, score }
    })
    .sort((left, right) => right.score - left.score)

  return ranked.find((entry) => entry.score > 0)?.filePath ?? null
}

const isBlockedIpv4Address = (value: string): boolean => {
  const parts = value.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true
  }

  const first = parts[0]
  const second = parts[1]
  if (first === undefined || second === undefined) {
    return true
  }

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19))
  )
}

const isBlockedIpv6Address = (value: string): boolean => {
  const normalized = value.toLowerCase()
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
}

const isBlockedIpAddress = (value: string): boolean => {
  const version = isIP(value)
  if (version === 4) {
    return isBlockedIpv4Address(value)
  }

  if (version === 6) {
    return isBlockedIpv6Address(value)
  }

  return true
}

const assertSafeFetchUrl = async (rawUrl: string): Promise<URL> => {
  const url = new URL(rawUrl)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs are allowed.')
  }

  if (url.username || url.password) {
    throw new Error('Authenticated URLs are not allowed.')
  }

  const hostname = url.hostname.toLowerCase()
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Private or local network URLs are not allowed.')
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new Error('Private or local network URLs are not allowed.')
    }

    return url
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Error('Private or local network URLs are not allowed.')
  }

  return url
}

export const shouldUseDocumentRead = (prompt: string): boolean =>
  /\b(doc|docs|read|spec|phase|architecture|implementation)\b/i.test(prompt) ||
  /\bdocs\/[A-Za-z0-9._/-]+\.md\b/.test(prompt)

export const shouldUseWebSearch = (prompt: string): boolean =>
  /\b(search|latest|look up|lookup|find on the web|web)\b/i.test(prompt)

export const shouldUseWebFetch = (prompt: string): boolean => URL_PATTERN.test(prompt)

export const runDocumentReadTool = async (prompt: string): Promise<ToolExecutionResult> => {
  const filePath = await selectDocumentPath(prompt)
  if (!filePath) {
    return {
      inputSummary: 'document query',
      outputPreview: 'No matching project documentation file was found.',
      toolName: 'document_read',
    }
  }

  const content = await readFile(filePath, 'utf8')
  return {
    inputSummary: filePath.replace(`${repoRoot}/`, ''),
    outputPreview: truncate(content),
    toolName: 'document_read',
  }
}

export const runWebFetchTool = async (prompt: string): Promise<ToolExecutionResult> => {
  const url = extractUrl(prompt)
  if (!url) {
    return {
      inputSummary: 'no url provided',
      outputPreview: 'No URL was present in the request.',
      toolName: 'web_fetch',
    }
  }

  const safeUrl = await assertSafeFetchUrl(url)
  const response = await fetch(safeUrl, {
    headers: {
      'user-agent': 'NessieWorker/0.0.0',
    },
    redirect: 'error',
  })
  const contentType = response.headers.get('content-type') ?? 'text/plain'
  const body = await response.text()
  const outputPreview = contentType.includes('text/html') ? stripHtml(body) : body

  return {
    inputSummary: safeUrl.toString(),
    outputPreview: truncate(outputPreview),
    toolName: 'web_fetch',
  }
}

export const runWebSearchTool = async (prompt: string): Promise<ToolExecutionResult> => {
  const query = prompt
    .replace(/\b(search|latest|look up|lookup|find on the web|web)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || prompt.trim()

  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetch(searchUrl, {
    headers: {
      'user-agent': 'NessieWorker/0.0.0',
    },
  })
  const html = await response.text()
  const matches = Array.from(
    html.matchAll(/result__a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g),
  ).slice(0, 3)

  const lines =
    matches.length > 0
      ? matches.map((match, index) => {
          const title = stripHtml(match[2] ?? 'Result')
          const url = match[1] ?? searchUrl
          return `${index + 1}. ${title} - ${url}`
        })
      : [`1. DuckDuckGo search - ${searchUrl}`]

  return {
    inputSummary: query,
    outputPreview: truncate(lines.join('\n')),
    toolName: 'web_search',
  }
}
