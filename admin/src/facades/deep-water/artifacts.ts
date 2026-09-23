import type { ApiClient } from '@nessie/client-core'
import {
  DeepWaterReportArtifactResponseSchema,
  deepWaterArtifactFileName,
  type DeepWaterArtifactKind,
  type DeepWaterReportArtifactResponse,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'
import { downloadAuthedPath } from '../../lib/uploads'
import { researchRunPath } from './hooks'

/**
 * A finished research's stored artifacts (nessie.md §7.9): the report exactly
 * as DeepWater returned it and its sources as CSV. Downloads and Copy markdown
 * read the stored files through the run's own viewer check; they never
 * re-render the Knowledge page, which carries Nessie's notes above the report.
 */

const ARTIFACT_FILE: Record<DeepWaterArtifactKind, string> = {
  report: 'report.md',
  sources: 'sources.csv',
}

export const researchArtifactPath = (runId: string, artifact: DeepWaterArtifactKind): string =>
  `${researchRunPath(runId)}/artifacts/${ARTIFACT_FILE[artifact]}`

export const downloadResearchArtifact = (
  run: Pick<DeepWaterResearchRunView, 'id' | 'reportKind' | 'title' | 'topic'>,
  artifact: DeepWaterArtifactKind,
  token: string | null,
): Promise<void> =>
  downloadAuthedPath(researchArtifactPath(run.id, artifact), deepWaterArtifactFileName(run, artifact), token)

export const fetchResearchReportMarkdown = (
  api: ApiClient,
  runId: string,
): Promise<DeepWaterReportArtifactResponse> =>
  api.get(`${researchRunPath(runId)}/artifacts/report`, DeepWaterReportArtifactResponseSchema)

export type ClipboardWriter = { writeText?: (text: string) => Promise<void> } | undefined

export type CopyOutcome = 'copied' | 'manual'

/**
 * Put text on the clipboard, or say that the person has to copy it by hand.
 * The Clipboard API is missing over plain HTTP and in some WebViews, and a
 * browser may refuse it once the click that asked has been spent on a fetch;
 * either way the caller shows the text selected for a manual copy rather than
 * claiming a copy that did not happen.
 */
export const copyText = async (text: string, clipboard: ClipboardWriter): Promise<CopyOutcome> => {
  if (!clipboard?.writeText) return 'manual'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch (error) {
    console.warn('[deep-water] the browser refused the clipboard; showing the report for a manual copy', error)
    return 'manual'
  }
}
