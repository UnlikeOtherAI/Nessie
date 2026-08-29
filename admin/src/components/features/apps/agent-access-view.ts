import type { AppAgentAccessRecord, AppDetailRecord } from '@nessie/schemas'
import { agentsAccessEmptyMessage, type AppEmptyMessage } from './app-detail-view'

/**
 * "Which agents may use this app", as a row model.
 *
 * The only two things that decide what an agent may call at run time are
 * `Agent.toolPolicy` and the install scope of the connection the tool came from
 * (`worker/src/run/mcp-toolset.ts` `isExposed`). `ToolGrant` rows exist and the
 * Tools page writes them, but the worker never reads one — so nothing here
 * touches them, and nothing here invents a third grant model.
 *
 * **One switch, many policy keys.** An app projects a whole capability list,
 * and the policy is keyed per projected row, so "this agent may use this app"
 * is written as the same verdict across *every* callable row of *every* one of
 * this app's connections. That is a fan-out, not a new concept, and it is the
 * reason `partial` is a first-class state below rather than a rounding error: a
 * per-capability edit on `/agents/tools`, a capability discovered after the
 * grant, or a fan-out that failed half way all leave an agent holding some rows
 * and not others. A checkbox that rendered those as "on" would be a checkbox
 * disagreeing with the data it claims to show.
 *
 * **The switch covers the rows the write route accepts, and says so.** The one
 * route that writes this verdict —
 * `PATCH /api/mcp/tools/:id/policy-targets/:agentId` — accepts a registry row
 * only while that row requires an explicit grant, answering
 * `TOOL_EXPLICIT_POLICY_NOT_SUPPORTED` for any other. A connection made through
 * the App Store projects rows that do require one, so its capabilities are
 * default-off and switchable here. A connection made the older way projects
 * rows that do not: the worker still honours a `false` verdict on such a row,
 * but this route will not write one, so the row is exposed wherever the
 * connection's scope reaches and nothing on this screen changes that.
 *
 * One app can hold both at once — two connected accounts, made two ways — so
 * the switch governs the rows it can actually move and the notice discloses the
 * rest by count. Rounding the mixed case either way is a control lying about
 * its data: withdrawing the switch loses a real decision the person came here
 * to make, and pretending it covers everything claims a write that 400s.
 */

// ─── The app's callable capability rows ─────────────────────────────────────

/** The registry fields this surface reads, and no more. */
export type AppAccessToolInput = {
  enabled: boolean
  id: string
  mcpInstanceId: string | null
  policyKey: string
  requiresExplicitGrant: boolean
  status: string
}

/**
 * `registryEntryId` addresses the write (it is the route's path parameter);
 * `policyKey` addresses the read (it is what the agent's policy is keyed by).
 * They coincide for a projected MCP row and deliberately stay two fields, so a
 * builtin that ever lands in this set cannot be read under the wrong key.
 */
export type AppAccessTool = {
  policyKey: string
  registryEntryId: string
}

export type AppAccessProjection = {
  /** Callable rows the per-agent write route accepts — what a switch may move. */
  grantable: AppAccessTool[]
  /** Callable rows exposed by the connection's scope alone; no route revokes one. */
  open: AppAccessTool[]
  /** Rows this app projected that nobody can call yet — awaiting review. */
  waiting: number
  /** The connected account holding those rows, so the notice points at the right one. */
  waitingConnectionId: string | null
}

/**
 * Only a row that is enabled and active counts: a `pending_review` projection
 * is a capability the app has, not access an agent holds. This mirrors
 * `callableRowsByInstance` in `packages/mcp-manage/src/apps/app-agent-access.ts`
 * — the server decides who *has* access with the same test, and the two
 * answering different questions about the same rows is how a list ends up
 * contradicting its own switches.
 */
export const projectAppAccessTools = (
  tools: readonly AppAccessToolInput[],
  connectionIds: readonly string[],
): AppAccessProjection => {
  const connections = new Set(connectionIds)
  const projection: AppAccessProjection = {
    grantable: [],
    open: [],
    waiting: 0,
    waitingConnectionId: null,
  }
  for (const tool of tools) {
    if (!tool.mcpInstanceId || !connections.has(tool.mcpInstanceId)) continue
    if (!tool.enabled || tool.status !== 'active') {
      projection.waiting += 1
      projection.waitingConnectionId ??= tool.mcpInstanceId
      continue
    }
    const entry = { policyKey: tool.policyKey, registryEntryId: tool.id }
    if (tool.requiresExplicitGrant) projection.grantable.push(entry)
    else projection.open.push(entry)
  }
  return projection
}

// ─── What control this viewer gets ──────────────────────────────────────────

export type AppAccessControl =
  | { kind: 'manageable'; open: AppAccessTool[]; tools: AppAccessTool[] }
  | { kind: 'not-connected' }
  | { kind: 'owner-only' }
  | { kind: 'awaiting-review'; connectionId: string }
  | { kind: 'no-capabilities' }
  | { kind: 'open-to-everyone'; openCount: number }

/**
 * `projection` is null for a viewer who cannot read the capability rows at all
 * (the registry and policy-target reads are owner-only), which is a different
 * answer from "there are none" and must not collapse into it.
 *
 * A single grantable row is enough to earn the switch: rows nobody can revoke
 * are a fact to disclose, never a reason to withhold a decision that is real.
 */
export const resolveAppAccessControl = (input: {
  canManage: boolean
  connectionIds: readonly string[]
  projection: AppAccessProjection | null
}): AppAccessControl => {
  if (input.connectionIds.length === 0) return { kind: 'not-connected' }
  if (!input.canManage || !input.projection) return { kind: 'owner-only' }
  const { grantable, open, waiting, waitingConnectionId } = input.projection
  if (grantable.length > 0) return { kind: 'manageable', open, tools: grantable }
  if (open.length > 0) return { kind: 'open-to-everyone', openCount: open.length }
  return waiting > 0 && waitingConnectionId
    ? { connectionId: waitingConnectionId, kind: 'awaiting-review' }
    : { kind: 'no-capabilities' }
}

export type AppAccessNotice = {
  body: string
  /** An in-product doorway to the screen that resolves the notice, if there is one. */
  href: string | null
  hrefLabel: string | null
}

/**
 * A notice earns its place by naming the next action, or by naming what the
 * control on screen does *not* cover. "You are not an owner" does neither, so
 * `owner-only` and `not-connected` say nothing here — the read-only list and
 * the empty state already carry those.
 */
export const appAccessNotice = (
  control: AppAccessControl,
  toolsHref: (connectionId: string) => string,
): AppAccessNotice | null => {
  switch (control.kind) {
    case 'awaiting-review':
      return {
        body:
          "This app's capabilities are waiting to be reviewed. Approve them and "
          + 'they can be given to an agent.',
        href: toolsHref(control.connectionId),
        hrefLabel: 'Review capabilities',
      }
    case 'no-capabilities':
      return {
        body:
          "This app hasn't shared anything it can do yet, so there is nothing to "
          + 'give an agent. Refreshing its capabilities is the next step.',
        href: null,
        hrefLabel: null,
      }
    case 'manageable':
      // Silent when every row is switchable; otherwise the count is the only
      // thing that keeps the switches below from over-claiming.
      return control.open.length === 0
        ? null
        : {
          body:
            `${control.open.length} of this app's capabilities need no per-agent `
            + 'grant, so any agent a connected account reaches can already use '
            + `them. These switches cover the other ${control.tools.length}.`,
          href: null,
          hrefLabel: null,
        }
    case 'open-to-everyone':
      return {
        body:
          `This app's ${control.openCount} capabilities need no per-agent grant, `
          + 'so any agent a connected account reaches can already use them — '
          + 'access cannot be given one agent at a time here.',
        href: null,
        hrefLabel: null,
      }
    default:
      return null
  }
}

// ─── Rows ───────────────────────────────────────────────────────────────────

export type AgentAccessRowState = 'granted' | 'none' | 'partial'

export type AgentAccessRow = {
  agentId: string
  /** Switchable rows this agent is allowed — what the switch reads. */
  grantedCount: number
  /** Server truth: this agent can call the app today, scope and policy agreeing. */
  hasAccess: boolean
  isPersonalAssistant: boolean
  name: string
  /** The line that admits what the switch alone would misstate. */
  note: string | null
  /** Rows of this app that need no grant at all. */
  openCount: number
  /** Of those, the ones this agent is not explicitly denied. */
  openUsableCount: number
  role: string | null
  state: AgentAccessRowState
  summary: string
  /** Switchable rows in total — the switch's own denominator. */
  toolCount: number
}

/** The agent fields `GET /api/mcp/tools/policy-targets` returns. */
export type AppAccessPolicyTarget = {
  agentKind: 'personal_assistant' | 'shared'
  id: string
  name: string
  role: string
  toolPolicy: Record<string, boolean>
}

export type AgentAccessMode = 'managed' | 'observed'

export type AgentAccessList = {
  mode: AgentAccessMode
  rows: AgentAccessRow[]
}

type AgentAccessCounts = Pick<
  AgentAccessRow,
  'grantedCount' | 'openCount' | 'openUsableCount' | 'state' | 'toolCount'
>

/**
 * With rows that need no grant in play, "No access" and "all N capabilities"
 * are both false — the agent already reaches those, and there are more of them
 * than the switch counts. One sentence over every callable row is the only
 * summary that stays true whether or not the app has such rows.
 */
const summarise = (counts: AgentAccessCounts): string => {
  if (counts.openCount > 0) {
    const usable = counts.grantedCount + counts.openUsableCount
    return `Can use ${usable} of ${counts.toolCount + counts.openCount} capabilities`
      + ` · ${counts.openCount} need no grant`
  }
  if (counts.state === 'none') return 'No access'
  if (counts.state === 'partial') {
    return `Can use ${counts.grantedCount} of ${counts.toolCount} capabilities`
  }
  return counts.toolCount === 1
    ? 'Can use the one capability'
    : `Can use all ${counts.toolCount} capabilities`
}

/**
 * An agent can hold every allow and still not reach the app: the connection's
 * install scope is a ceiling the policy never lifts. Saying so is the whole
 * point of keeping the server's `agentsWithAccess` beside the policy — the
 * switch answers "is it allowed", and only the server answers "can it".
 */
const noteFor = (input: {
  hasAccess: boolean
  openUsableCount: number
  state: AgentAccessRowState
}): string | null => {
  if (input.hasAccess) return null
  if (input.state === 'none' && input.openUsableCount === 0) return null
  return 'Allowed, but no connected account reaches this agent yet.'
}

const managedRow = (
  target: AppAccessPolicyTarget,
  control: { open: readonly AppAccessTool[]; tools: readonly AppAccessTool[] },
  accessible: ReadonlySet<string>,
): AgentAccessRow => {
  const grantedCount = control.tools.filter(
    (tool) => target.toolPolicy[tool.policyKey] === true,
  ).length
  // An explicit-grant row is off until granted; a row that needs no grant is on
  // unless denied. The same two rules `agentCanUseApp` applies on the server.
  const openUsableCount = control.open.filter(
    (tool) => target.toolPolicy[tool.policyKey] !== false,
  ).length
  const counts: AgentAccessCounts = {
    grantedCount,
    openCount: control.open.length,
    openUsableCount,
    state:
      grantedCount === 0
        ? 'none'
        : grantedCount === control.tools.length
          ? 'granted'
          : 'partial',
    toolCount: control.tools.length,
  }
  const hasAccess = accessible.has(target.id)
  return {
    ...counts,
    agentId: target.id,
    hasAccess,
    isPersonalAssistant: target.agentKind === 'personal_assistant',
    name: target.name,
    note: noteFor({ hasAccess, openUsableCount, state: counts.state }),
    role: target.role,
    summary: summarise(counts),
  }
}

const observedRow = (agent: AppAgentAccessRecord): AgentAccessRow => ({
  agentId: agent.agentId,
  grantedCount: 0,
  hasAccess: true,
  isPersonalAssistant: false,
  name: agent.name,
  note: null,
  openCount: 0,
  openUsableCount: 0,
  role: agent.role,
  state: 'granted',
  summary: 'Can use this app',
  toolCount: 0,
})

/**
 * Managed rows come from the whole editable roster, not from the agents that
 * already have access — a list you can only take away from is not a control.
 * Observed rows come from the server's own answer, which is already scoped to
 * what this caller is entitled to see.
 */
export const buildAgentAccessList = (input: {
  agentsWithAccess: readonly AppAgentAccessRecord[]
  control: AppAccessControl
  targets: readonly AppAccessPolicyTarget[]
}): AgentAccessList => {
  if (input.control.kind !== 'manageable') {
    return { mode: 'observed', rows: input.agentsWithAccess.map(observedRow) }
  }
  const accessible = new Set(input.agentsWithAccess.map((agent) => agent.agentId))
  const control = input.control
  return {
    mode: 'managed',
    rows: input.targets.map((target) => managedRow(target, control, accessible)),
  }
}

/**
 * What a row should read while its write is in flight.
 *
 * Only the switchable rows move: a row that needs no grant is untouched by the
 * write, so its counts carry through unchanged. Reach is deliberately *not*
 * predicted either — whether a newly allowed agent can actually call the app
 * depends on the connection's scope, which only the server knows, so the note
 * is dropped rather than guessed and comes back with the refetch. Rolling back
 * is the caller dropping this preview.
 */
export const previewAgentAccessRow = (
  row: AgentAccessRow,
  enabled: boolean,
): AgentAccessRow => {
  const grantedCount = enabled ? row.toolCount : 0
  const state: AgentAccessRowState = enabled ? 'granted' : 'none'
  return {
    ...row,
    grantedCount,
    note: null,
    state,
    summary: summarise({ ...row, grantedCount, state }),
  }
}

/**
 * An in-flight switch, paired with the server value it was computed from.
 *
 * The pairing is what makes rollback need no timer and no effect: the preview
 * stands only while the server still says what it said when the write started.
 * The moment the refetch lands — with the new value, or with someone else's
 * change — the server wins, so success cannot flicker back through the old
 * value and a stale preview cannot outlive the row it was based on.
 */
export type PendingAgentAccess = {
  baseline: AgentAccessRowState
  preview: AgentAccessRow
}

export const beginAgentAccessWrite = (
  row: AgentAccessRow,
  enabled: boolean,
): PendingAgentAccess => ({
  baseline: row.state,
  preview: previewAgentAccessRow(row, enabled),
})

export const resolveAgentAccessRow = (
  row: AgentAccessRow,
  pending: PendingAgentAccess | null,
): AgentAccessRow =>
  pending && pending.baseline === row.state ? pending.preview : row

/** An agent reaches the app through a grant, or through a row needing none. */
const rowIsAllowed = (row: AgentAccessRow): boolean =>
  row.state !== 'none' || row.openUsableCount > 0

export const agentAccessHeadline = (list: AgentAccessList): string => {
  if (list.mode === 'observed') {
    const count = list.rows.length
    return `${count} ${count === 1 ? 'agent' : 'agents'} can use this app`
  }
  const allowed = list.rows.filter(rowIsAllowed).length
  return `${allowed} of ${list.rows.length} agents allowed to use this app`
}

export const agentAccessToggleLabel = (row: AgentAccessRow, appName: string): string =>
  row.state === 'none'
    ? `Let ${row.name} use ${appName}`
    : `Remove ${row.name}'s access to ${appName}`

/**
 * The consequence of the control, at the foot of the list. The managed wording
 * says what an unchecked row means, because "why can't my agent see this tool?"
 * is the support question this tab exists to pre-answer — and where some rows
 * need no grant, an unchecked row does *not* mean nothing, so it says that
 * instead of the reassuring version that would be false.
 */
const CHANGE_TIMING =
  'Changes take effect immediately; a running agent finishes its current step.'

export const agentAccessConsequence = (list: AgentAccessList): string => {
  if (list.mode === 'observed') {
    return 'Agents that are not listed here cannot see or call this app at all. '
      + 'Removing access takes effect immediately; a running agent finishes its '
      + 'current step.'
  }
  if (list.rows.some((row) => row.openCount > 0)) {
    return 'An agent you do not allow can still call the capabilities that need '
      + `no grant, and nothing else from this app. ${CHANGE_TIMING}`
  }
  return `An agent you do not allow cannot see or call this app at all. ${CHANGE_TIMING}`
}

export type AgentAccessEmptyState = {
  message: AppEmptyMessage
  /** `sole` replaces the list; `notice` sits above a list that can still be used. */
  placement: 'notice' | 'sole'
}

/**
 * With a roster on screen the empty message is a notice rather than a
 * replacement: the switches that answer it are the thing it must not hide. And
 * it is only true while nothing reaches the app — a row needing no grant is
 * access somebody already holds, so the message is dropped rather than shown
 * over evidence to the contrary.
 */
export const agentAccessEmptyState = (
  app: AppDetailRecord,
  list: AgentAccessList,
): AgentAccessEmptyState | null => {
  if (list.rows.length === 0) {
    return { message: agentsAccessEmptyMessage(app), placement: 'sole' }
  }
  if (list.mode === 'managed' && !list.rows.some(rowIsAllowed)) {
    return { message: agentsAccessEmptyMessage(app), placement: 'notice' }
  }
  return null
}

/**
 * One switch is many writes, so a failure part way through is a real state and
 * not an error to swallow: the capabilities that landed keep their new verdict
 * and the row honestly reads `partial` after the refetch.
 */
export const agentAccessWriteFailure = (input: {
  landed: number
  reason: string
  total: number
}): string => {
  if (input.landed === 0) return input.reason
  return `Only ${input.landed} of ${input.total} capabilities changed — ${input.reason}`
}
