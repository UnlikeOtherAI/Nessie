import type { TaskSetSource } from '@nessie/schemas'

/** One address for the workload, whether reached from Documents or a conversation. */
export const taskSetPath = (id: string): string => `/agents/task-sets/${encodeURIComponent(id)}`

export const taskSetSourceFormat = (filename: string): TaskSetSource['format'] | undefined => {
  const extension = filename.split('.').pop()?.toLowerCase()
  return (['csv', 'tsv', 'xlsx', 'sqlite', 'json', 'jsonl'] as const).find((format) => format === extension)
}

export const taskSetCreatePath = (source?: {
  pageId: string; versionId: string; format?: TaskSetSource['format']
}): string => {
  if (!source) return '/agents/task-sets/new'
  const params = new URLSearchParams({ sourcePageId: source.pageId, sourceVersionId: source.versionId })
  if (source.format) params.set('format', source.format)
  return `/agents/task-sets/new?${params}`
}
