import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { DeepWaterResearchRunView } from '@nessie/schemas'
import { faArrowUpRightFromSquare, faCopy, faDownload } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import {
  copyText,
  downloadResearchArtifact,
  fetchResearchReportMarkdown,
} from '../../../facades/deep-water/artifacts'
import { openExternalUrl, usesExternalUrlShell } from '../../../lib/open-external-url'
import { useApiClient } from '../../../providers/ApiClientProvider'
import { useAuthSession } from '../../../providers/AuthSessionProvider'
import { downloadReportLabel } from './research-presentation'

/**
 * A finished research's artifacts, wherever its result lands — the research
 * card, the result reply and Knowledge › Research rows (nessie.md §7.9, Rule
 * zero "reuse the surface"): download the report exactly as DeepWater wrote
 * it, download its sources, copy the report's markdown, and open the public
 * page when the person published it. Each is the viewer's own authorised read
 * of the stored file; nothing here renders the Knowledge page.
 */

type CopyState =
  | { kind: 'idle' }
  | { kind: 'copying' }
  | { kind: 'copied' }
  | { kind: 'manual'; markdown: string }
  | { kind: 'failed' }

const buttonClass = 'admin-button admin-button-secondary admin-button-compact gap-1.5'

export const hasResearchArtifacts = (run: DeepWaterResearchRunView): boolean =>
  Boolean(run.artifacts?.report || run.artifacts?.sources || run.publicUrl)

export const ResearchArtifactActions = ({ run }: { run: DeepWaterResearchRunView }) => {
  const api = useApiClient()
  const { token } = useAuthSession()
  const [copy, setCopy] = useState<CopyState>({ kind: 'idle' })
  const [downloadError, setDownloadError] = useState<string | null>(null)

  useEffect(() => {
    if (copy.kind !== 'copied') return undefined
    const timer = window.setTimeout(() => setCopy({ kind: 'idle' }), 2_000)
    return () => window.clearTimeout(timer)
  }, [copy.kind])

  if (!hasResearchArtifacts(run)) return null

  const download = (artifact: 'report' | 'sources') => {
    setDownloadError(null)
    downloadResearchArtifact(run, artifact, token).catch((error: unknown) => {
      console.error('[deep-water] artifact download failed', { artifact, error, runId: run.id })
      setDownloadError('That file couldn’t be downloaded. Try again.')
    })
  }

  const copyMarkdown = async () => {
    setCopy({ kind: 'copying' })
    try {
      const report = await fetchResearchReportMarkdown(api, run.id)
      const outcome = await copyText(report.markdown, navigator.clipboard)
      setCopy(outcome === 'copied' ? { kind: 'copied' } : { kind: 'manual', markdown: report.markdown })
    } catch (error) {
      console.error('[deep-water] reading the report for Copy markdown failed', { error, runId: run.id })
      setCopy({ kind: 'failed' })
    }
  }

  const openPublic = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!run.publicUrl || !usesExternalUrlShell()) return
    event.preventDefault()
    void openExternalUrl(run.publicUrl)
  }

  return (
    <div className="flex flex-col gap-2" data-testid="research-artifact-actions">
      <div className="flex flex-wrap items-center gap-2">
        {run.artifacts?.report ? (
          <button className={buttonClass} onClick={() => download('report')} type="button">
            <FontAwesomeIcon aria-hidden="true" className="h-3 w-3" icon={faDownload} />
            {downloadReportLabel(run.reportKind)}
          </button>
        ) : null}
        {run.artifacts?.sources ? (
          <button className={buttonClass} onClick={() => download('sources')} type="button">
            <FontAwesomeIcon aria-hidden="true" className="h-3 w-3" icon={faDownload} />
            Download sources (.csv)
          </button>
        ) : null}
        {run.artifacts?.report ? (
          <button
            className={buttonClass}
            disabled={copy.kind === 'copying'}
            onClick={() => void copyMarkdown()}
            type="button"
          >
            <FontAwesomeIcon aria-hidden="true" className="h-3 w-3" icon={faCopy} />
            {copy.kind === 'copied' ? 'Copied' : copy.kind === 'copying' ? 'Copying…' : 'Copy markdown'}
          </button>
        ) : null}
        {run.publicUrl ? (
          <a
            className={buttonClass}
            href={run.publicUrl}
            onClick={openPublic}
            rel="noopener noreferrer"
            target="_blank"
          >
            <FontAwesomeIcon aria-hidden="true" className="h-3 w-3" icon={faArrowUpRightFromSquare} />
            Open on research.deepwater.live
          </a>
        ) : null}
      </div>
      {downloadError ? (
        <p className="text-xs text-[color:var(--danger-text)]" role="alert">{downloadError}</p>
      ) : null}
      {copy.kind === 'failed' ? (
        <p className="text-xs text-[color:var(--danger-text)]" role="alert">
          The report couldn’t be read for copying. Try again.
        </p>
      ) : null}
      {copy.kind === 'manual' ? (
        <ManualCopy markdown={copy.markdown} onDone={() => setCopy({ kind: 'idle' })} />
      ) : null}
    </div>
  )
}

/**
 * The clipboard fallback: when the browser will not let Nessie copy, the
 * markdown is shown selected so the person can copy it themselves.
 */
const ManualCopy = ({ markdown, onDone }: { markdown: string; onDone: () => void }) => {
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [])
  return (
    <div className="flex flex-col gap-2" data-testid="research-manual-copy">
      <p className="text-xs text-[color:var(--tx2)]">
        Your browser didn’t let Nessie copy this. The markdown is selected below — copy it with
        Ctrl+C (⌘C on a Mac).
      </p>
      <textarea
        aria-label="Report markdown"
        className="admin-input h-40 w-full font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
        readOnly
        ref={field}
        value={markdown}
      />
      <div>
        <button className="admin-button admin-button-secondary admin-button-compact" onClick={onDone} type="button">
          Done
        </button>
      </div>
    </div>
  )
}
