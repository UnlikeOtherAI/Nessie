import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { DeepWaterBriefOriginRequest } from '@nessie/schemas'
import {
  RESEARCH_INTENT,
  readResearchBriefPrefill,
  researchBriefHref,
} from '../../../facades/deep-water/navigation'
import { useRedirect } from '../../../navigation/redirect'
import { ResearchBriefDialog } from './ResearchBriefDialog'

/**
 * The one place a screen shows a DeepWater research brief over itself.
 *
 * Mounted by the screens a brief belongs to — a conversation (its origin is
 * that thread) and Knowledge › Research (its origin is the person's Personal
 * Assistant conversation) — it owns the `?research=<runId>` state param, the
 * new-brief form that has no run yet, and the pre-filled question an older
 * card or a failed research hands over in router state. Everything that opens
 * a brief on this screen — the composer button, the research card, a list row,
 * a notice's "Start again" — asks this host through `useResearchBriefDoorway`,
 * so there is one dialog and one way in (Rule zero: reuse the surface).
 */

type NewBrief = { topic: string }

type ResearchBriefHostValue = {
  open: (runId: string) => void
  openNew: (topic?: string) => void
}

const ResearchBriefHostContext = createContext<ResearchBriefHostValue | null>(null)

export const ResearchBriefHost = ({
  children,
  origin,
}: {
  children: ReactNode
  /** Where a new brief's result comes back; null while the screen has no conversation yet. */
  origin: DeepWaterBriefOriginRequest | null
}) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const redirect = useRedirect()
  const runId = searchParams.get(RESEARCH_INTENT)
  const [newBrief, setNewBrief] = useState<NewBrief | null>(null)

  const writeRunId = useCallback((next: string | null) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (next) params.set(RESEARCH_INTENT, next)
        else params.delete(RESEARCH_INTENT)
        return params
      },
      { replace: true, state: location.state },
    )
  }, [location.state, setSearchParams])

  const open = useCallback((next: string) => {
    setNewBrief(null)
    writeRunId(next)
  }, [writeRunId])

  const openNew = useCallback((topic?: string) => {
    if (runId) writeRunId(null)
    setNewBrief({ topic: topic ?? '' })
  }, [runId, writeRunId])

  // A doorway elsewhere handed over a question to start from. It is taken
  // once and the router state is dropped, so Back and a reload land on the
  // conversation, never on a half-filled form.
  const prefillTopic = readResearchBriefPrefill(location.state)?.topic ?? null
  useEffect(() => {
    if (prefillTopic === null) return
    setNewBrief({ topic: prefillTopic })
    redirect({ hash: location.hash, pathname: location.pathname, search: location.search })
    // Once per arrival: the entry's key names the arrival that carried the
    // question, and the redirect that drops it is a new entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key])

  const close = useCallback(() => {
    setNewBrief(null)
    if (runId) writeRunId(null)
  }, [runId, writeRunId])

  const value = useMemo(() => ({ open, openNew }), [open, openNew])

  return (
    <ResearchBriefHostContext.Provider value={value}>
      {children}
      {runId || newBrief ? (
        <ResearchBriefDialog
          initialTopic={newBrief?.topic ?? ''}
          onClose={close}
          onCreated={open}
          onStartAgain={openNew}
          origin={origin}
          runId={runId}
        />
      ) : null}
    </ResearchBriefHostContext.Provider>
  )
}

/**
 * Open a research's brief: over this screen when a host is mounted, else by
 * going to the conversation it belongs to (or Knowledge › Research), where
 * that screen's host opens it.
 */
export const useResearchBriefDoorway = () => {
  const host = useContext(ResearchBriefHostContext)
  const navigate = useNavigate()
  return useMemo(() => ({
    open: (run: { id: string; origin: { channelId: string | null } }) => {
      if (host) host.open(run.id)
      else void navigate(researchBriefHref(run))
    },
    /** A new brief from this screen, pre-filled with a question; null without a host. */
    openNew: host ? host.openNew : null,
  }), [host, navigate])
}
