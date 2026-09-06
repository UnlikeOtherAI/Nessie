import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { attributionFromActorContext } from '@nessie/runtime'
import {
  HttpFetchError,
  runWebSearch,
  type WebSearchOptions,
  type WebSearchOutput,
} from './builtin-handlers/index.js'
import { postWebSearchCard } from './web-search-card.js'
import { assertSafeUrl, safeFetch, UrlSafetyError } from './builtin-handlers/url-safety.js'
import { hashJsonValue, MAX_TOOL_RESULT_CHARS, truncate } from './tool-util.js'
import type {
  BuiltinToolRuntimeContext,
  ToolExecutionResult,
} from './tool-types.js'

// Read-only "content" tools the agent uses to bring in outside information:
// Ledger-metered web search, web fetch (a single URL), and project document read.

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

/** A positive integer argument (page, count) or nothing — never a zero or a NaN. */
export const coercePositiveInteger = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * One entry point for every web search a run makes — the agent tool and the
 * workflow step both come through here, so provenance and paging are decided
 * in one place.
 *
 * The query is passed through verbatim. It used to have `search`, `latest`,
 * `web` and friends stripped out of it by a regex, which mangled honest
 * queries ("latest iPhone" → "iPhone", "web design" → "design"), only worked
 * in English, and was exactly the content keyword-matching `AGENTS.md`
 * forbids. Writing a good query is the model's job.
 */
export const collectWebSearchResults = async (
  query: string,
  page: number | undefined,
  context: Omit<WebSearchOptions, 'page'>,
): Promise<WebSearchOutput> =>
  runWebSearch(query, {
    ...context,
    page,
  })

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
  // The model chooses this URL, so it is the most directly attacker-steerable
  // egress in the product. safeFetch resolves once, pins the socket to the
  // vetted address (no rebinding window), and re-validates every redirect hop
  // rather than refusing redirects outright.
  let response: Response
  let safeUrl: URL
  try {
    safeUrl = await assertSafeUrl(rawUrl)
    response = await safeFetch(safeUrl, {
      headers: {
        'user-agent': 'NessieWorker/0.0.0',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof UrlSafetyError) {
      throw new HttpFetchError(error.message)
    }
    throw error
  }
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
  context: BuiltinToolRuntimeContext,
  prompt: string,
  options: { count?: number; page?: number; present?: boolean } = {},
): Promise<ToolExecutionResult> => {
  const result = await collectWebSearchResults(prompt, options.page, {
    attribution: attributionFromActorContext(context.actorContext, {
      agentId: context.agentId,
      agentKind: context.agentKind,
      runId: context.run.id,
    }),
    ...(options.count === undefined ? {} : { count: options.count }),
    ledgerIdentity: context.ledgerIdentity,
    toolCallId: context.toolCallId ?? '',
  })

  // Presenting is a second, visible act: the model gets the same grounded
  // results either way, and a card only appears because it asked for one.
  const presented = options.present ? await postWebSearchCard(context, result) : null

  return {
    inputSummary:
      [
        result.query,
        result.page > 1 ? `(page ${result.page})` : '',
        presented ? '(presented)' : '',
      ].filter(Boolean).join(' '),
    outputPreview: truncate(
      presented
        ? `${result.text}\n\nPosted these results to the conversation as a search card `
          + 'the person can page through. Do not repeat the list back to them; say what '
          + 'it means.'
        : result.text,
    ),
    toolName: 'web_search',
  }
}
