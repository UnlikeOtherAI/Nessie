import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWebSearch } from './builtin-handlers/index.js'
import { assertSafeUrl } from './builtin-handlers/url-safety.js'
import { hashJsonValue, MAX_TOOL_RESULT_CHARS, truncate } from './tool-util.js'
import type { ToolExecutionResult } from './tool-types.js'

// Read-only "content" tools the agent uses to bring in outside information:
// web search (serper.dev), web fetch (a single URL), and project document read.

const MAX_FETCH_RESPONSE_BYTES = 512_000
const FETCH_TIMEOUT_MS = 15_000
const URL_PATTERN = /https?:\/\/[^\s)]+/i
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const docsRoot = resolve(repoRoot, 'docs')
const docsRootPrefix = `${docsRoot}${sep}`

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

export const coercePage = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export const collectWebSearchResults = async (
  query: string,
  page?: number,
): Promise<{
  query: string
  page: number
  answer: string | null
  results: Array<{ title: string; url: string; snippet: string }>
  text: string
}> => {
  const normalizedQuery = query
    .replace(/\b(search|latest|look up|lookup|find on the web|web)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || query.trim()

  return runWebSearch(normalizedQuery, { page })
}

const readResponseText = async (
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
  if (!response.body) {
    const text = await response.text()
    const encoded = new TextEncoder().encode(text)
    if (encoded.byteLength <= maxBytes) {
      return { text, truncated: false }
    }
    return {
      text: new TextDecoder().decode(encoded.subarray(0, maxBytes)),
      truncated: true,
    }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytesRead = 0
  let text = ''
  let truncated = false

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }

    const value = chunk.value
    bytesRead += value.byteLength

    if (bytesRead > maxBytes) {
      const overflow = bytesRead - maxBytes
      const allowedBytes = Math.max(0, value.byteLength - overflow)
      text += decoder.decode(value.subarray(0, allowedBytes), { stream: true })
      truncated = true
      await reader.cancel()
      break
    }

    text += decoder.decode(value, { stream: true })
  }

  text += decoder.decode()

  return { text, truncated }
}

export const collectWebFetchResult = async (
  rawUrl: string,
): Promise<{
  content: string
  contentHash: string
  contentType: string
  text: string
  truncated: boolean
  url: string
}> => {
  const safeUrl = await assertSafeUrl(rawUrl)
  const response = await fetch(safeUrl, {
    headers: {
      'user-agent': 'NessieWorker/0.0.0',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const contentType = response.headers.get('content-type') ?? 'text/plain'
  const { text: body, truncated: bodyTruncated } = await readResponseText(
    response,
    MAX_FETCH_RESPONSE_BYTES,
  )
  const text = contentType.includes('text/html') ? stripHtml(body) : body
  const truncated = bodyTruncated || text.length > MAX_TOOL_RESULT_CHARS
  const content = truncated ? text.slice(0, MAX_TOOL_RESULT_CHARS) : text

  return {
    content,
    contentHash: hashJsonValue(text),
    contentType,
    text,
    truncated,
    url: safeUrl.toString(),
  }
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

  const result = await collectWebFetchResult(url)

  return {
    inputSummary: result.url,
    outputPreview: truncate(result.text),
    toolName: 'web_fetch',
  }
}

export const runWebSearchTool = async (
  prompt: string,
  page?: number,
): Promise<ToolExecutionResult> => {
  const result = await collectWebSearchResults(prompt, page)

  return {
    inputSummary: result.page > 1 ? `${result.query} (page ${result.page})` : result.query,
    outputPreview: truncate(result.text),
    toolName: 'web_search',
  }
}
