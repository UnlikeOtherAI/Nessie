import { readFile, readdir } from 'node:fs/promises'
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

const truncate = (value: string, maxLength = MAX_PREVIEW_LENGTH): string =>
  value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`

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

  return ranked[0]?.filePath ?? null
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
  const url = prompt.match(URL_PATTERN)?.[0]
  if (!url) {
    return {
      inputSummary: 'no url provided',
      outputPreview: 'No URL was present in the request.',
      toolName: 'web_fetch',
    }
  }

  const response = await fetch(url, {
    headers: {
      'user-agent': 'NessieWorker/0.0.0',
    },
  })
  const contentType = response.headers.get('content-type') ?? 'text/plain'
  const body = await response.text()
  const outputPreview = contentType.includes('text/html') ? stripHtml(body) : body

  return {
    inputSummary: url,
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
