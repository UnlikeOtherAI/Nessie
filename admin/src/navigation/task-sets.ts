import type { TaskSetSource } from '@nessie/schemas'

/** One address for the workload, whether reached from Documents or a conversation. */
export const taskSetPath = (id: string): string =>
  `/admin/automations/batch-jobs/${encodeURIComponent(id)}`

/** Automations with its Batch jobs tab open: where a batch job's Back returns. */
export const BATCH_JOBS_PATH = '/admin/automations?tab=batch-jobs'

export const taskSetSourceFormat = (filename: string): TaskSetSource['format'] | undefined => {
  const extension = filename.split('.').pop()?.toLowerCase()
  return (['csv', 'tsv', 'xlsx', 'sqlite', 'json', 'jsonl'] as const).find((format) => format === extension)
}

export const taskSetCreatePath = (source?: {
  pageId: string; versionId: string; format?: TaskSetSource['format']
}): string => {
  if (!source) return '/admin/automations/batch-jobs/new'
  const params = new URLSearchParams({ sourcePageId: source.pageId, sourceVersionId: source.versionId })
  if (source.format) params.set('format', source.format)
  return `/admin/automations/batch-jobs/new?${params}`
}
