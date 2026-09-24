import type { DeepWaterReportKind } from './deep-water-run-state.js'

/**
 * The file names a finished DeepWater research downloads under (Water plan
 * nessie.md §7.9, amendments N10): the slugged title, or the question until
 * the research has a title, then `.md` for the report — `-summary.md` when
 * DeepWater could only write the research summary — and `.csv` for its
 * sources. One function, so the API's `Content-Disposition` and the admin's
 * download name can never disagree.
 */

export type DeepWaterArtifactKind = 'report' | 'sources'

/** A name with nothing left in it after slugging still downloads as something readable. */
const FALLBACK_BASE = 'deepwater-research'
const MAX_BASE_LENGTH = 80

const slug = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/, '')

export const deepWaterArtifactFileName = (
  run: { title: string | null; topic: string; reportKind: DeepWaterReportKind | null },
  artifact: DeepWaterArtifactKind,
): string => {
  const base = slug(run.title?.trim() || run.topic) || FALLBACK_BASE
  if (artifact === 'sources') return `${base}.csv`
  return run.reportKind === 'summary' ? `${base}-summary.md` : `${base}.md`
}
