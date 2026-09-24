import { ApiClientError, type ApiClient } from '@nessie/client-core'
import type { QueryClient } from '@tanstack/react-query'
import {
  DeepWaterResearchRunViewSchema,
  type DeepWaterBriefView,
  type DeepWaterResearchReadinessState,
  type DeepWaterResearchRunView,
} from '@nessie/schemas'

import {
  INTEGRATION_RUN_UPDATED_EVENT,
  invalidateResearchRun,
  researchRunIdFromFrame,
} from '../../src/facades/deep-water/events'
import {
  CHANNEL, JANA, ME, PA_AGENT, REPORT_MARKDOWN, RUN, TEAM,
  agentBrief, answeredBrief, createdBrief, draftBrief, listedRuns, olderLauncherRuns,
} from './fixture-data'

/**
 * The server side of the research-brief fixture: a stubbed ApiClient that
 * answers as the brief API does, and the hooks the runner drives it with
 * (`window.__research`). Each change reaches the screen as a realtime
 * `integration.run.updated` frame, read by the shell's own frame reader
 * (`researchRunIdFromFrame`) and handled by `invalidateResearchRun`, exactly
 * as `useDeepWaterRunEvents` handles one off the event stream. DeepWater's
 * progress pushes arrive the same way (`progresses`), and nothing polls: the
 * runner counts the requests between two frames (`calls`).
 *
 * `?readiness=` sets the server's verdict on the products list (`unreadable`
 * sends one outside the contract), and `?owner=1` or `?admin=1` the viewer's
 * role and so the verdict's cancel standing; `?brief=` picks the person's
 * brief (`drafting`, `opening-failed` — the planner could not answer the
 * question that opened it — or `sign-in`); `?agent=sign-in` blocks the agent's
 * brief on its requester's changed sign-in; `?create=` makes opening a brief
 * lose its first answer (`lost-once`) or be refused because DeepWater was
 * turned off meanwhile (`not-ready`); `?many=1` adds enough older research for
 * a second page of Knowledge › Research at ten a page, and `?sparse=1` answers
 * its first page empty with more to come, as the server's bounded read does
 * when every row it read was one the viewer may not see; `?block=hidden` makes
 * turning DeepWater off be refused by a research the owner may not read.
 *
 * Opening a brief is idempotent by its `actionId`, as the API is. A cancel is
 * answered as the API answers it: accepted (202) with the research still open
 * and the cancel in flight; the runner settles it later (`cancelSettles`), or
 * has DeepWater refuse it (`cancelRefused`).
 */

const params = new URLSearchParams(location.search)
const readiness = params.get('readiness') ?? 'ready'
const owner = params.get('owner') === '1'
const admin = params.get('admin') === '1'
const briefVariant = params.get('brief') ?? 'drafting'
const agentVariant = params.get('agent')
const createVariant = params.get('create')
const many = params.get('many') === '1'
const sparse = params.get('sparse') === '1'
const blockedByHidden = params.get('block') === 'hidden'

const toRun = (brief: DeepWaterBriefView): DeepWaterResearchRunView =>
  DeepWaterResearchRunViewSchema.strip().parse(brief)

/** Nessie's words for a planner turn that stalled (`deepWaterPlannerFailureMessage`). */
const PLANNER_STALLED = 'DeepWater’s research planner stopped responding before it answered.'
const failedTurn = { actionId: null, message: PLANNER_STALLED, retryable: true, status: 'failed' } as const
/** Nessie's words for a cancel DeepWater could not be asked about (`deepWaterCancelFailureMessage`). */
export const CANCEL_UNREACHED = 'DeepWater couldn’t be reached, so this research wasn’t cancelled. Try again in a few minutes.'

const personBrief = (): DeepWaterBriefView => {
  if (briefVariant === 'opening-failed') {
    // No turn has been answered: the transcript is empty and the brief is as it was opened.
    return draftBrief({
      analysis: null, lockedSettings: [], messages: [], openQuestions: [], pillarCount: 0, pillars: [],
      plannerTurn: failedTurn, revision: 0,
    })
  }
  if (briefVariant === 'sign-in') {
    return draftBrief({ delivery: { blockedReason: 'requester_identity_changed', state: 'blocked' } })
  }
  return draftBrief()
}

const agentsBrief = (): DeepWaterBriefView => {
  const brief = agentBrief()
  return agentVariant === 'sign-in'
    ? { ...brief, delivery: { blockedReason: 'requester_identity_changed', state: 'blocked' },
      viewer: { ...brief.viewer, canRetryDelivery: true } }
    : brief
}

const RUNS = '/api/integrations/products/deep-water/research-runs'
/** The cursor a bounded read answers with when it found nothing the viewer may see. */
const BOUND_CURSOR = 'read-bound-1'

export const createFixtureServer = (queryClient: QueryClient) => {
  /** One `integration.run.updated`, framed as the realtime hub sends it and read as the shell reads it. */
  const announce = (id: string) => {
    const frame = {
      data: JSON.stringify({
        data: { productSlug: 'deep-water', runId: id },
        event: INTEGRATION_RUN_UPDATED_EVENT,
        ts: new Date().toISOString(),
        type: 'event',
      }),
      event: INTEGRATION_RUN_UPDATED_EVENT,
    }
    const runId = researchRunIdFromFrame(frame)
    if (runId) invalidateResearchRun(queryClient, runId)
  }

  const briefs = new Map<string, DeepWaterBriefView>([[RUN.draft, personBrief()], [RUN.agentDraft, agentsBrief()]])
  const runs = new Map<string, DeepWaterResearchRunView>(
    [...listedRuns(), ...(many ? olderLauncherRuns(8) : [])].map((entry) => [entry.id, entry]),
  )
  const store = { conflictNext: false, createLost: createVariant === 'lost-once', teamEnabled: readiness !== 'team_off',
    upgraded: false }
  /** The brief each opening key opened: the same key again is answered with it. */
  const opened = new Map<string, DeepWaterBriefView>()
  const calls: { body?: unknown; method: string; path: string }[] = []

  const runView = (id: string): DeepWaterResearchRunView | null => {
    const brief = briefs.get(id)
    return brief ? toRun(brief) : runs.get(id) ?? null
  }
  const notFound = () => new ApiClientError('Not found', 'DEEP_WATER_RESEARCH_NOT_FOUND', 404)

  const verdictState = (): string => {
    if (readiness === 'unreadable') return 'paused'
    // Turned on (or updated) here, a team is ready; otherwise the verdict the run asked for.
    return !store.teamEnabled ? 'team_off' : readiness === 'team_off' || store.upgraded ? 'ready' : readiness
  }

  const product = () => ({
    capabilities: [], category: 'research', id: '90000000-0000-4000-8000-000000000001', name: 'DeepWater',
    // The cancel standing: owners and admins (amendments N8.5).
    research: { state: verdictState() as DeepWaterResearchReadinessState, viewerCanChangeTeam: owner || admin },
    slug: 'deep-water', summary: 'Deep research, agreed first.',
    teamEnablement: { enabled: store.teamEnabled, teamId: TEAM },
  })

  const get = async (path: string): Promise<unknown> => {
    calls.push({ method: 'GET', path })
    const route = new URL(path, location.origin).pathname
    if (route === '/api/integrations/products') return [product()]
    if (route === '/api/users') {
      return [{ displayName: 'Ondřej Rafaj', id: ME }, { displayName: 'Jana Nováková', id: JANA }]
    }
    if (route === '/api/agents') return [{ id: PA_AGENT, name: 'Personal Assistant', status: 'idle' }]
    if (route === '/api/personal-assistant') return null
    const match = new RegExp(`^${RUNS}/([^/]+)(/brief|/artifacts/report)?$`).exec(route)
    if (match) {
      const [, id = '', tail] = match
      if (tail === '/brief') {
        const brief = briefs.get(id) ?? null
        if (brief) return brief
        throw notFound()
      }
      const view = runView(id)
      if (!view) throw notFound()
      if (tail === '/artifacts/report') return { markdown: REPORT_MARKDOWN, reportKind: view.reportKind, truncated: false }
      return view
    }
    return []
  }

  const updateBrief = (id: string, update: (brief: DeepWaterBriefView) => DeepWaterBriefView): DeepWaterBriefView => {
    const brief = briefs.get(id)
    if (!brief) throw notFound()
    const next = update(brief)
    briefs.set(id, next)
    return next
  }

  const conflict = (id: string) => {
    store.conflictNext = false
    // DeepWater's planner moved the brief on while the person was editing.
    const moved = updateBrief(id, (brief) => ({
      ...brief, revision: (brief.revision ?? 0) + 1, settings: { ...brief.settings!, depth: 'heavy' },
    }))
    return new ApiClientError('The brief changed', 'DEEP_WATER_BRIEF_REVISION_CONFLICT', 409,
      { currentRevision: moved.revision })
  }

  const cancel = (id: string, actionId: string, since: string): unknown => {
    // Accepted: the research stays open, with the cancel in flight, until DeepWater stops it.
    if (briefs.has(id)) {
      return toRun(updateBrief(id, (entry) => ({
        ...entry,
        cancelFailure: null,
        pendingAction: { actionId, error: null, kind: 'cancel', since },
        viewer: { ...entry.viewer, canEdit: false, canStart: false },
      })))
    }
    // An owner who may not read the research is answered with its id and status only.
    if (id === RUN.hidden && owner) return { id, status: 'running' }
    const view = runs.get(id)
    if (!view) throw notFound()
    // A newer cancel is in flight: the last one's failure no longer stands.
    const accepted = { ...view, cancelFailure: null }
    runs.set(id, accepted)
    return accepted
  }

  const post = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ body, method: 'POST', path })
    const route = new URL(path, location.origin).pathname
    if (route === RUNS) {
      const key = String(body?.actionId)
      const replay = opened.get(key)
      if (replay) return briefs.get(replay.id) ?? replay
      if (createVariant === 'not-ready') {
        // DeepWater was turned off for the team after the products list was read.
        store.teamEnabled = false
        throw new ApiClientError('DeepWater is off', 'DEEP_WATER_NOT_READY', 409, { reason: 'team_off' })
      }
      const created = createdBrief(String(body?.topic))
      briefs.set(created.id, created)
      opened.set(key, created)
      if (store.createLost) {
        // Opened, but the answer never came back.
        store.createLost = false
        throw new TypeError('Failed to fetch')
      }
      return created
    }
    const match = new RegExp(`^${RUNS}/([^/]+)/(messages|start|cancel|deliver)$`).exec(route)
    const [, id = '', action] = match ?? []
    const since = new Date().toISOString()
    const actionId = String(body?.actionId)
    if (action === 'messages') {
      if (store.conflictNext) throw conflict(id)
      return updateBrief(id, (brief) => ({
        ...brief,
        pendingAction: { actionId, error: null, kind: 'reply', since },
        plannerTurn: { actionId, since, status: 'replying' },
        viewer: { ...brief.viewer, canEdit: false, canStart: false },
      }))
    }
    if (action === 'start') {
      if (store.conflictNext) throw conflict(id)
      return toRun(updateBrief(id, (brief) => ({
        ...brief, pendingAction: { actionId, error: null, kind: 'launch', since }, status: 'starting',
      })))
    }
    if (action === 'cancel') return cancel(id, actionId, since)
    if (action === 'deliver') {
      return toRun(updateBrief(id, (brief) => ({ ...brief, delivery: { blockedReason: null, state: 'pending' } })))
    }
    return { ok: true }
  }

  const patch = async (path: string, body?: Record<string, unknown>): Promise<unknown> => {
    calls.push({ body, method: 'PATCH', path })
    if (body?.enabled === false && blockedByHidden) {
      // A research in a conversation the owner is not in: named, never shown.
      throw new ApiClientError('Deep Water run is still running', 'LEDGER_DEEPWATER_ACTIVE_RUNS', 409, {
        channelId: null, id: RUN.hidden, originKind: 'person', requestedByUserId: JANA, status: 'running',
      })
    }
    // Turning DeepWater off would strand the agent's running research.
    if (body?.enabled === false && runs.get(RUN.running)?.status === 'running') {
      throw new ApiClientError('Deep Water run is still running', 'LEDGER_DEEPWATER_ACTIVE_RUNS', 409, {
        channelId: CHANNEL, id: RUN.running, originKind: 'agent', requestedByUserId: ME, status: 'running',
      })
    }
    store.teamEnabled = body?.enabled === true
    // Turning it on installs the current research tools, which is how a team is updated.
    if (store.teamEnabled) store.upgraded = true
    return product()
  }

  /** Forward only, as the brief API pages: a cursor names the last row of the page before. */
  const getPage = async (path: string) => {
    calls.push({ method: 'GET', path })
    const query = new URL(path, location.origin).searchParams
    const limit = Number(query.get('limit') ?? '25')
    const after = query.get('cursor')
    if (sparse && !after) {
      // The bounded read found only research this viewer may not see: an empty page, and more to come.
      return { data: { items: [], meta: { hasMore: true, nextCursor: BOUND_CURSOR, prevCursor: null } } }
    }
    const own = [...briefs.values()].filter((brief) => brief.status !== 'cancelled').map(toRun)
    const all = [...own, ...runs.values()]
    const start = after && after !== BOUND_CURSOR ? all.findIndex((entry) => entry.id === after) + 1 : 0
    const items = all.slice(start, start + limit)
    const hasMore = start + limit < all.length
    return {
      data: { items, meta: { hasMore, nextCursor: hasMore ? items.at(-1)?.id ?? null : null, prevCursor: null } },
    }
  }

  const client = {
    delete: async () => null, get, getPage, patch, post, put: async () => null,
  } as unknown as ApiClient

  /** The server's side, driven by the runner. */
  const runner = {
    calls,
    /** How many briefs opening a brief has opened: a replayed key opens none. */
    openedBriefs: () => opened.size,
    /** DeepWater stops a research whose cancel was accepted. */
    cancelSettles: (id: string) => {
      if (briefs.has(id)) {
        updateBrief(id, (brief) => ({ ...brief, pendingAction: null, status: 'cancelled',
          viewer: { ...brief.viewer, canCancel: false, canEdit: false, canStart: false } }))
      } else {
        const view = runs.get(id)
        if (view) runs.set(id, { ...view, status: 'cancelled', viewer: { ...view.viewer, canCancel: false } })
      }
      announce(id)
    },
    /** DeepWater could not be asked to stop a research whose cancel was accepted: it stays open, and says why. */
    cancelRefused: (id: string) => {
      const view = runs.get(id)
      if (view) runs.set(id, { ...view, cancelFailure: { code: 'unavailable', message: CANCEL_UNREACHED } })
      announce(id)
    },
    conflictNext: () => {
      store.conflictNext = true
    },
    /** DeepWater pushes where a running research stands; the run is announced as the worker announces it. */
    progresses: (id: string, progress: DeepWaterResearchRunView['progress']) => {
      const view = runs.get(id)
      if (view) runs.set(id, { ...view, progress })
      else updateBrief(id, (brief) => ({ ...brief, progress }))
      announce(id)
    },
    launched: (id: string) => {
      updateBrief(id, (brief) => ({ ...brief, pendingAction: null, startedAt: new Date().toISOString(),
        status: 'running', viewer: { ...brief.viewer, canEdit: false, canStart: false } }))
      announce(id)
    },
    /** DeepWater's planner stalls on the person's last reply: no transcript row, the action cleared. */
    plannerFails: (id: string) => {
      updateBrief(id, (brief) => ({
        ...brief,
        pendingAction: null,
        plannerTurn: failedTurn,
        viewer: { ...brief.viewer, canEdit: true, canStart: true },
      }))
      announce(id)
    },
    plannerAnswers: (id: string) => {
      const reply = calls.filter((call) => call.method === 'POST' && call.path.endsWith(`${id}/messages`)).at(-1)
      const body = (reply?.body ?? {}) as { message?: string; pillars?: string[]; settings?: object }
      updateBrief(id, (brief) => ({
        ...answeredBrief(brief, String(body.message), { pillars: body.pillars, settings: body.settings }),
        viewer: { ...brief.viewer, canEdit: true, canStart: true },
      }))
      announce(id)
    },
  }

  return { client, runner }
}
