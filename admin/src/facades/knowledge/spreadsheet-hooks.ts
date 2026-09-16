import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  SpreadsheetBootstrapSchema,
  type SpreadsheetBootstrap,
  type SpreadsheetSelection,
} from '@nessie/schemas'
import { knowledgeKeys } from './keys'
import type { KnowledgePageRecord } from './hooks'
import { useApiClient } from '../../providers/ApiClientProvider'
import { useAuthSession } from '../../providers/AuthSessionProvider'
import { uploadFileWithProgress, type UploadProgress } from '../../lib/upload-xhr'

// Every spreadsheet call the pane makes, against the routes phases.md §"Wave A
// / Phase 2" names. Nothing here knows about IronCalc: the pane owns the
// engine, the facade owns the wire.
//
// Until Phase 2 lands these are the only place a path is spelled, so the stub
// harness can answer them from a fixture and the real routes drop in without
// touching a component.

const base = '/api/knowledge-base'

export type SpreadsheetImportWarning = { detail: string; kind: string }

export type SpreadsheetImportResult = {
  page: KnowledgePageRecord
  warnings: SpreadsheetImportWarning[]
}

export type SpreadsheetSortRequest = {
  /** Sheet index, 0-based, as the engine addresses it. */
  sheet: number
  range: SpreadsheetSelection
  /** Absolute column indexes, in priority order. */
  keys: { column: number; direction: 'asc' | 'desc' }[]
  hasHeaderRow: boolean
}

export type SpreadsheetFilterCriterion =
  | { blanks: boolean; kind: 'values'; values: string[] }
  | {
      caseSensitive?: boolean
      kind: 'condition'
      op:
        | 'between' | 'contains' | 'empty' | 'endsWith' | 'eq' | 'gt' | 'gte'
        | 'lt' | 'lte' | 'ne' | 'notContains' | 'notEmpty' | 'startsWith'
      value: string
      value2?: string
    }

export type SpreadsheetFilterModel = {
  appliedAtSeq: string
  columns: Record<number, SpreadsheetFilterCriterion>
  range: SpreadsheetSelection
  sort?: { column: number; direction: 'asc' | 'desc' }
}

export type SpreadsheetReplaceRefusal = { a1: string; reason: string; sheet: number }

export type SpreadsheetReplaceResult = {
  refusals: SpreadsheetReplaceRefusal[]
  replaced: number
}

/**
 * The bootstrap. Id-keyed, so it carries no `placeholderData` from a sibling
 * page: handing the pane another document's snapshot would build the wrong
 * workbook, which is exactly the failure the id-keyed rule exists to stop
 * (src/lib/query-keys.ts). `staleTime: Infinity` because the live lane, not a
 * refetch, is what keeps a mounted workbook current.
 */
export const useSpreadsheetBootstrap = (pageId?: string) => {
  const apiClient = useApiClient()

  return useQuery<SpreadsheetBootstrap>({
    enabled: Boolean(pageId),
    gcTime: 0,
    queryFn: () =>
      apiClient.get(`${base}/pages/${pageId}/spreadsheet`, SpreadsheetBootstrapSchema),
    queryKey: knowledgeKeys.spreadsheet(pageId),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

const invalidateSpace = (
  queryClient: ReturnType<typeof useQueryClient>,
  spaceId?: string,
): void => {
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.pages(spaceId) })
  void queryClient.invalidateQueries({ queryKey: knowledgeKeys.myDocs })
}

export const useCreateSpreadsheet = (spaceId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { parentPageId?: string | null; taskId?: string; title: string }) =>
      apiClient.post<KnowledgePageRecord>(`${base}/spaces/${spaceId}/spreadsheets`, input),
    onSuccess: () => invalidateSpace(queryClient, spaceId),
  })
}

export const useImportSpreadsheet = (spaceId?: string) => {
  const { token } = useAuthSession()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: { file: File; onProgress?: (progress: UploadProgress) => void }) =>
      uploadFileWithProgress<SpreadsheetImportResult>(
        `${base}/spaces/${spaceId}/spreadsheets/import`,
        file,
        token,
        onProgress,
      ),
    onSuccess: () => invalidateSpace(queryClient, spaceId),
  })
}

/** "Open as spreadsheet" on an `.xlsx`/`.csv` file node: a new page beside it. */
export const useConvertToSpreadsheet = (spaceId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (pageId: string) =>
      apiClient.post<SpreadsheetImportResult>(`${base}/pages/${pageId}/convert-to-spreadsheet`),
    onSuccess: () => invalidateSpace(queryClient, spaceId),
  })
}

/**
 * "Save version". Versioning is the safety net this feature ships instead of an
 * approval gate, so it is never rate-limited behind a retention policy and the
 * comment is the only thing a person has to supply.
 */
export const useSaveSpreadsheetVersion = (pageId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: { changeComment: string }) =>
      apiClient.post(`${base}/pages/${pageId}/spreadsheet/versions`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.versions(pageId) })
      void queryClient.invalidateQueries({ queryKey: knowledgeKeys.page(pageId) })
    },
  })
}

/** Sort, freeze, insert/delete rows and columns: the pane and the tools share
 *  one server implementation, so a person and an agent sort identically. */
export const useRestructureSpreadsheet = (pageId?: string) => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: SpreadsheetSortRequest & { action: 'sort' }) =>
      apiClient.post(`${base}/pages/${pageId}/spreadsheet/structure`, input),
  })
}

export const useSpreadsheetFilter = (pageId?: string, sheet?: number) => {
  const apiClient = useApiClient()

  return useQuery<SpreadsheetFilterModel | null>({
    enabled: Boolean(pageId) && sheet !== undefined,
    queryFn: () =>
      apiClient.get(`${base}/pages/${pageId}/spreadsheet/filters/${sheet}`),
    queryKey: knowledgeKeys.spreadsheetFilter(pageId, sheet),
  })
}

export const useSetSpreadsheetFilter = (pageId?: string) => {
  const apiClient = useApiClient()
  const queryClient = useQueryClient()
  const invalidate = (sheet: number) => {
    void queryClient.invalidateQueries({
      queryKey: knowledgeKeys.spreadsheetFilter(pageId, sheet),
    })
  }

  return {
    clear: useMutation({
      mutationFn: (sheet: number) =>
        apiClient.delete(`${base}/pages/${pageId}/spreadsheet/filters/${sheet}`),
      onSuccess: (_data, sheet) => invalidate(sheet),
    }),
    // Re-application is explicit, the Excel/Sheets rule: editing a value does
    // not re-filter until asked, so a row never vanishes under the cursor.
    reapply: useMutation({
      mutationFn: (sheet: number) =>
        apiClient.post(`${base}/pages/${pageId}/spreadsheet/filters/${sheet}/reapply`),
      onSuccess: (_data, sheet) => invalidate(sheet),
    }),
    set: useMutation({
      mutationFn: ({ model, sheet }: { model: SpreadsheetFilterModel; sheet: number }) =>
        apiClient.put(`${base}/pages/${pageId}/spreadsheet/filters/${sheet}`, model),
      onSuccess: (_data, { sheet }) => invalidate(sheet),
    }),
  }
}

/**
 * Find runs against the client model with no round trip; only Replace goes
 * through the route, so the change lands in the journal like any other batch
 * and refusals come back per cell.
 */
export const useReplaceInSpreadsheet = (pageId?: string) => {
  const apiClient = useApiClient()

  return useMutation({
    mutationFn: (input: {
      all: boolean
      inFormulas: boolean
      matchCase: boolean
      query: string
      regex: boolean
      replacement: string
      scope: 'range' | 'sheet' | 'workbook'
      selection?: SpreadsheetSelection
      sheet: number
      wholeCell: boolean
    }) =>
      apiClient.post<SpreadsheetReplaceResult>(
        `${base}/pages/${pageId}/spreadsheet/replace`,
        input,
      ),
  })
}

export const spreadsheetExportPath = (
  pageId: string,
  format: 'csv' | 'xlsx',
  options: { sheet?: number; versionId?: string } = {},
): string => {
  const query = new URLSearchParams({ format })
  if (options.sheet !== undefined) query.set('sheet', String(options.sheet))
  if (options.versionId) query.set('versionId', options.versionId)
  return `${base}/pages/${pageId}/spreadsheet/export?${query.toString()}`
}
