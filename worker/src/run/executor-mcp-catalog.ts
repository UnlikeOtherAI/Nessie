import { ExecutorMcpToolCatalogSchema, type ExecutorMcpTool } from '@nessie/schemas'

import type { ExecutorMcpInputSchemaLookup } from './executor-tool-arguments.js'
import type { AgenticToolResult } from './tools.js'

// The daemon fits each page to its 64 KiB result budget, so Kelpie's catalog
// is one or two pages; sixteen covers the protocol's 512-tool ceiling.
const MAX_CATALOG_PAGES = 16

/**
 * A program's whole catalog, or the one failure that stopped this run from
 * reading it. `toolCallRecordId` is the first page's durable ToolCall, which
 * the agent loop ends with the answer it shows the model; a catalog this run
 * already holds was fetched by an earlier call and has none.
 */
export type ExecutorMcpCatalogAnswer =
  | { server: string; toolCallRecordId?: string; tools: readonly ExecutorMcpTool[] }
  | { failure: AgenticToolResult }

export type ExecutorMcpCatalogs = {
  inputSchemaOf: ExecutorMcpInputSchemaLookup
  load: (server: string, providerToolCallId: string) => Promise<ExecutorMcpCatalogAnswer>
}

const catalogPage = (output: string) => {
  try {
    const parsed = ExecutorMcpToolCatalogSchema.safeParse((JSON.parse(output) as { catalog?: unknown }).catalog)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const failed = (inputSummary: string, output: string, toolCallRecordId?: string): { failure: AgenticToolResult } => ({
  failure: { inputSummary, output, success: false, ...(toolCallRecordId ? { toolCallRecordId } : {}) },
})

/**
 * The run's own copy of each program's catalog.
 *
 * `mcp.tools` is still the daemon's paged operation, unchanged; the worker
 * walks the pages once per program per run and keeps the whole catalog, so a
 * listing, one tool's schema and the argument shaping all answer from it
 * without another round trip to the machine. Pages after the first are
 * separate commands with their own ToolCall rows, which the walk ends itself —
 * left open, the newest of them would read as a tool still running.
 */
export const createExecutorMcpCatalogs = (input: {
  endPage: (toolCallRecordId: string, result: AgenticToolResult, durationMs: number) => Promise<void>
  listPage: (args: { cursor?: string; server: string }, providerToolCallId: string) => Promise<AgenticToolResult>
  mcpServers: () => readonly string[]
}): ExecutorMcpCatalogs => {
  const catalogs = new Map<string, readonly ExecutorMcpTool[]>()
  return {
    inputSchemaOf: (server, tool) => catalogs.get(server)?.find((entry) => entry.name === tool)?.inputSchema,
    load: async (server, providerToolCallId) => {
      const inputSummary = `server=${server}`
      const cached = catalogs.get(server)
      if (cached) return { server, tools: cached }
      const named = input.mcpServers()
      if (!named.includes(server)) {
        const refusal = failed(
          inputSummary,
          `This machine's reviewed policy names no program \`${server.slice(0, 40)}\`. Its programs: ${named.join(', ') || 'none'}.`,
        )
        return { failure: { ...refusal.failure, correctable: true } }
      }
      const tools: ExecutorMcpTool[] = []
      let cursor: string | undefined
      let digest: string | undefined
      let firstRecordId: string | undefined
      for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
        const startedAt = Date.now()
        const result = await input.listPage(
          { server, ...(cursor === undefined ? {} : { cursor }) },
          page === 1 ? providerToolCallId : `${providerToolCallId}:page-${page}`,
        )
        if (page === 1) firstRecordId = result.toolCallRecordId
        else if (result.toolCallRecordId) await input.endPage(result.toolCallRecordId, result, Date.now() - startedAt)
        if (!result.success) return { failure: { ...result, toolCallRecordId: firstRecordId } }
        const listed = catalogPage(result.output)
        if (!listed || listed.server !== server) {
          return failed(inputSummary, `The program \`${server}\` answered with a catalog this run cannot read.`, firstRecordId)
        }
        // Every page of one catalog carries the digest of the whole; a change
        // means the program was restarted with other tools between pages.
        if (digest !== undefined && listed.digest !== digest) {
          return failed(inputSummary, `The program \`${server}\` changed its tools while they were being listed. List them again.`, firstRecordId)
        }
        digest = listed.digest
        tools.push(...listed.tools)
        if (!listed.nextCursor) {
          catalogs.set(server, tools)
          return { server, tools, ...(firstRecordId ? { toolCallRecordId: firstRecordId } : {}) }
        }
        cursor = listed.nextCursor
      }
      return failed(inputSummary, `The program \`${server}\` lists more catalog pages than this run reads.`, firstRecordId)
    },
  }
}
