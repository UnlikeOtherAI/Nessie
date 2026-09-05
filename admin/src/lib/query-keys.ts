/**
 * The admin's React Query cache keys, in one place.
 *
 * Keys are cache identity, and React Query matches them by prefix. Two rules
 * follow, and this module exists so both are checkable rather than remembered:
 *
 * 1. A family's root is the prefix of every key beneath it, so invalidating the
 *    root reaches the whole family.
 * 2. A sub-resource nests under its parent's root instead of claiming a root of
 *    its own. `['project-members', id]` is unreachable from `['projects']`, so
 *    every mutation that refreshed the parent left the child silently stale —
 *    the failure mode this module removes.
 *
 * Rule 1 is enforced by `test/query-key-invariants.test.ts`, not by this
 * comment. A handful of sub-resources deliberately keep a root of their own,
 * because nesting would cost more than the staleness it fixes; each is listed
 * there with its reason, and the test fails both when a new key escapes its
 * root and when a listed exception stops being needed. A prose list here would
 * drift the first time someone added a key without reading it — which is the
 * disease this file treats.
 *
 * A factory is the only way to build a key: a raw literal at a call site is a
 * second definition that stops matching the moment either side moves. That rule
 * is enforced too — the same test scans every file under `admin/src` and fails
 * on an array literal handed to `queryKey` or to the query filters, because
 * within weeks of this module landing seven of them had reappeared. Every
 * family exposes `all` because it is that family's invalidation prefix and the
 * root the invariant test measures its members against.
 *
 * One family lives elsewhere on purpose: the billing keys in
 * `facades/billing/hooks.ts` are scoped per UOA org/team and are built beside
 * the code that resolves that scope.
 */

export const agentKeys = {
  all: ['agents'] as const,
  pausedPrivateCount: ['agents', 'paused-private-count'] as const,
  // The org-wide list is a different corpus from the caller's own agents, and
  // both live under the family root so one invalidation covers them.
  allScopes: ['agents', 'all'] as const,
  activity: (agentId?: string) => ['agents', agentId, 'activity'] as const,
  children: (agentId?: string) => ['agents', agentId, 'children'] as const,
  documents: (agentId?: string) => ['agents', agentId, 'documents'] as const,
  messages: (agentId: string) => ['agents', agentId, 'messages'] as const,
  messagePage: (agentId: string | undefined, limit: number, offset: number) =>
    ['agents', agentId, 'messages', limit, offset] as const,
  models: ['agents', 'models'] as const,
  runTools: (agentId?: string, runId?: string) =>
    ['agents', agentId, 'runs', runId, 'tools'] as const,
  status: (agentId?: string) => ['agents', agentId, 'status'] as const,
  // An absent id keeps its slot rather than collapsing to a placeholder, so a
  // disabled render and an enabled one agree on cache identity.
  triggers: (agentId?: string) => ['agents', agentId, 'triggers'] as const,
  // Live run state. Deliberately a child of the trigger-list key: it holds its
  // own fast refetch cadence while something is running, and every existing
  // invalidation of the list already reaches it, so firing or pausing a
  // trigger refreshes what the row says it is doing.
  triggerActivity: (agentId?: string) => ['agents', agentId, 'triggers', 'activity'] as const,
}

// To-dos are an agent sub-resource. Keeping them beneath the agents root means
// an agent update still refreshes every mounted per-agent view, while the
// to-do facade can invalidate the precise collection after a checklist write.
export const agentTodoKeys = {
  all: agentKeys.all,
  card: (todoId?: string) => ['agents', 'todos', todoId] as const,
  instances: (agentId?: string) => ['agents', agentId, 'todos'] as const,
  templates: (agentId?: string, includeArchived = false) =>
    ['agents', agentId, 'todo-templates', includeArchived] as const,
}

export const alertKeys = {
  all: ['alerts'] as const,
  list: (limit: number, unreadOnly: boolean) =>
    ['alerts', { limit, unreadOnly }] as const,
  summary: ['alerts', 'summary'] as const,
}

const appsRoot = ['apps'] as const

export const appKeys = {
  all: appsRoot,
  // "Show all" walks one shelf's own pages — a category, or the flat Installed
  // list, which has no category and keys on null. A different corpus from the
  // mixed catalogue slice `list` holds, under the same root, so a single
  // invalidation after a connect or disconnect still reaches both.
  shelf: (category: string | null, installed: boolean) =>
    [...appsRoot, 'shelf', category, installed] as const,
  detail: (slug?: string) => [...appsRoot, 'detail', slug ?? null] as const,
  // The facade normalises before it calls this, so each field is spelled one
  // way by the time it reaches the key. The defaults restate that normal form
  // rather than inventing a second one: an absent query is the empty search,
  // an absent `installed` is the unnarrowed catalogue, an absent offset is the
  // first page.
  list: (filters: {
    category?: string
    installed?: boolean
    offset?: number
    query?: string
  }) =>
    [
      ...appsRoot,
      'list',
      filters.query ?? '',
      filters.category ?? null,
      filters.installed === true,
      filters.offset ?? 0,
    ] as const,
}

/** Viewer-scoped, durable card state; the message itself contains only its id. */
export const appConnectionRequestKeys = {
  card: (requestId?: string) => ['app-connection-requests', requestId ?? null] as const,
}

export const agentCardKeys = {
  card: (cardId?: string) => ['agent-cards', cardId ?? null] as const,
}

export const approvalKeys = {
  all: ['approvals'] as const,
  detail: (approvalId?: string) => ['approvals', approvalId ?? null] as const,
  mailSendDraft: (toolName: 'gmail_draft_send' | 'mailbox_send', approvalId?: string) =>
    ['approvals', approvalId ?? null, 'mail-send-draft', toolName] as const,
  pendingCount: ['approvals', 'pending-count'] as const,
}

export const demonstrationKeys = {
  all: ['demonstrations'] as const,
  active: (channelId?: string) => ['demonstrations', 'active', channelId] as const,
}

export const auditLogKeys = {
  forAction: (action: string) => ['audit-log', action] as const,
}

// Automatic team access after sign-in. Scoped by surface, because the
// organisation and team reads return different subsets of the same shape.
export const automaticMembershipKeys = {
  all: ['automatic-membership'] as const,
  forScope: (scope: 'organization' | 'team') => ['automatic-membership', scope] as const,
}

export const authKeys = {
  myAvatarRevision: ['auth', 'me', 'avatar', 'revision'] as const,
  providers: ['auth', 'providers'] as const,
  sessions: ['auth', 'sessions'] as const,
}

/**
 * Roots only. The scoped keys are built in the billing facade, which owns the
 * UOA capability scope that has to be part of cache identity — one team's
 * manager projection must never be reused after an active-team switch.
 */
export const billingKeys = {
  capability: ['uoa-billing-capability'] as const,
  credits: ['uoa-billing-credits'] as const,
  recurringAddons: ['uoa-billing-recurring-addons'] as const,
  statement: ['uoa-billing-statement'] as const,
}

export const budgetKeys = {
  all: ['budgets'] as const,
}

export const callKeys = {
  all: ['call'] as const,
  forChannel: (channelId?: string) => ['call', channelId] as const,
}

export const channelKeys = {
  all: ['channels'] as const,
  messageSearch: (channelId: string | undefined, query: string) =>
    ['channels', channelId, 'messages', 'search', query] as const,
}

export const commsKeys = {
  connections: ['comms', 'connections'] as const,
  connection: (id: string) => ['comms', 'connections', id] as const,
}

// Nested so the family rule holds and `dashboardKeys.all` reaches it — nothing
// more. A widget's own mutations (layout, removal, lock) invalidate
// `detail(dashboardId)`, which does NOT reach this key, and that is unchanged
// from before: widget data is refetched by its own reads, not by editing the
// dashboard around it. Every rendered view of one widget spreads this prefix,
// so the compact and full reads share an invalidation.
const dashboardWidgetDataKey = (widgetId: string) =>
  ['dashboards', 'widget-data', widgetId] as const

export const dashboardKeys = {
  all: ['dashboards'] as const,
  detail: (dashboardId?: string) => ['dashboards', dashboardId] as const,
  embed: (embedId: string) => ['dashboard-embed', embedId] as const,
  // `querySuffix` is the request's own query string: a filtered list and a
  // compact widget render are different responses and cannot share an entry.
  // The 'list' segment keeps the unfiltered list off `detail`'s shape: both
  // took one free segment under the root, so `list('')` and a disabled
  // `detail(undefined)` used to be the same cache entry with two response types.
  list: (querySuffix: string) => ['dashboards', 'list', querySuffix] as const,
  sourceNotes: (dashboardId?: string) =>
    [...dashboardKeys.detail(dashboardId), 'source-notes'] as const,
  sources: ['dashboard-sources'] as const,
  versions: (dashboardId: string) => ['dashboards', dashboardId, 'versions'] as const,
  widgetDataAll: ['dashboards', 'widget-data'] as const,
  widgetData: dashboardWidgetDataKey,
  widgetDataView: (widgetId: string, querySuffix: string) =>
    [...dashboardWidgetDataKey(widgetId), querySuffix] as const,
}

export const executorKeys = {
  all: ['executors'] as const,
  detail: (executorId: string) => ['executors', executorId] as const,
  access: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'access'] as const,
  accessChange: (accessChangeId?: string) =>
    ['executors', 'access-change', accessChangeId ?? 'none'] as const,
  myWorkspaceReviews: ['executors', 'workspace-reviews', 'mine'] as const,
  pairing: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'pairing'] as const,
  workspacePromotion: (promotionId?: string) =>
    ['executors', 'team-promotion', promotionId ?? 'none'] as const,
  workspaceReviews: (executorId?: string) =>
    ['executors', executorId ?? 'none', 'team-reviews'] as const,
}

export const favoriteKeys = {
  all: ['favorites'] as const,
}

export const feedbackKeys = {
  all: ['feedback'] as const,
}

export const iterationKeys = {
  all: ['iterations'] as const,
  forProject: (projectId: string) => ['iterations', projectId] as const,
}

export const knowledgeKeys = {
  annotations: (pageId?: string) =>
    ['knowledge-annotations', pageId ?? 'none'] as const,
  annotationsByKind: (pageId?: string, kind?: string) =>
    ['knowledge-annotations', pageId ?? 'none', kind ?? 'all'] as const,
  attachments: (pageId?: string) =>
    ['knowledge-page-attachments', pageId ?? 'none'] as const,
  // Backlinks and mentions are views of one page's links, so they nest under
  // that page: editing a page invalidates them along with its body.
  backlinks: (pageId?: string) =>
    ['knowledge-page', pageId ?? 'none', 'backlinks'] as const,
  mentions: (pageId?: string) =>
    ['knowledge-page', pageId ?? 'none', 'mentions'] as const,
  myDocs: ['knowledge-my-docs'] as const,
  page: (pageId?: string) => ['knowledge-page', pageId ?? 'none'] as const,
  pages: (spaceId?: string) => ['knowledge-pages', spaceId ?? 'none'] as const,
  recentPages: (projectId: string | undefined, limit: number) =>
    ['knowledge-recent-pages', projectId ?? 'none', limit] as const,
  // A project-scoped list is a different corpus from the org-wide one, so it
  // gets its own entry under the shared spaces root.
  scopedSpaces: (projectId?: string) =>
    ['knowledge-spaces', projectId ?? 'organization'] as const,
  space: (spaceId?: string) => ['knowledge-spaces', spaceId ?? 'none'] as const,
  spaces: ['knowledge-spaces'] as const,
  storageUsage: (scopeType: string, scopeId?: string) =>
    ['knowledge-storage-usage', scopeType, scopeId ?? 'self'] as const,
  versions: (pageId?: string) => ['knowledge-versions', pageId ?? 'none'] as const,
  wikilinkSuggestions: (query: string) =>
    ['knowledge-wikilink-suggestions', query] as const,
  zip: (pageId?: string, versionId?: string) =>
    ['knowledge-zip', pageId ?? 'none', versionId ?? 'none'] as const,
  zipEntry: (pageId?: string, versionId?: string, path?: string | null) =>
    ['knowledge-zip-entry', pageId ?? 'none', versionId ?? 'none', path ?? 'none'] as const,
}

export const mcpKeys = {
  tools: ['mcp-tools'] as const,
}

/**
 * Integration reads are entitlement-switched surfaces: the caller's org, team,
 * user, and owner verdict decide what comes back, so all four are part of cache
 * identity. Each family keeps a bare prefix beside its scoped key so a mutation
 * can invalidate every scope at once.
 */
export type IntegrationQueryScope = {
  isOwner: boolean
  organizationId: string
  teamId: string
  userId: string
}

const scopeParts = (scope: IntegrationQueryScope) => [
  scope.organizationId,
  scope.teamId,
  scope.userId,
  scope.isOwner ? 'owner' : 'member',
] as const

export const integrationManifestKey = (productSlug?: string) =>
  ['integrations', 'manifest', productSlug ?? 'none'] as const

export const integratedProductsKeyPrefix =
  ['integrations', 'products', 'catalog'] as const

export const integratedProductsKey = (scope: IntegrationQueryScope) => [
  ...integratedProductsKeyPrefix,
  ...scopeParts(scope),
] as const

export const deepWaterResearchRunsKeyPrefix =
  ['integrations', 'products', 'deep-water', 'research-runs'] as const

export const deepWaterResearchRunsKey = (scope: IntegrationQueryScope) => [
  ...deepWaterResearchRunsKeyPrefix,
  ...scopeParts(scope),
] as const

export const deepWaterAgentAccessKeyPrefix =
  ['integrations', 'products', 'deep-water', 'agent-access'] as const

export const deepWaterAgentAccessKey = (scope: IntegrationQueryScope) => [
  ...deepWaterAgentAccessKeyPrefix,
  ...scopeParts(scope),
] as const

export const mcpToolRegistryKey = (
  scope: IntegrationQueryScope,
  enabled: boolean,
  filters: {
    scopeKey?: string
    source?: string
    status?: string
  },
) => [
  ...mcpKeys.tools,
  ...scopeParts(scope),
  enabled ? 'enabled' : 'disabled',
  filters.status ?? null,
  filters.source ?? null,
  filters.scopeKey ?? null,
] as const

export const toolPolicyTargetsKeyPrefix =
  [...mcpKeys.tools, 'policy-targets'] as const

export const toolPolicyTargetsKey = (scope: {
  isOwner: boolean
  organizationId: string
  userId: string
}) => [
  ...toolPolicyTargetsKeyPrefix,
  scope.organizationId,
  scope.userId,
  scope.isOwner ? 'owner' : 'member',
] as const

export const opsHealthKeys = {
  all: ['ops-health'] as const,
}

/** Owner-only local telemetry behind `/ops/usage` — never customer billing. */
export const opsTelemetryKeys = {
  connectorSummary: (groupBy: string) => ['connector-summary', groupBy] as const,
  fileUsageSummary: ['file-usage-summary'] as const,
  pricingProfiles: ['pricing-profiles'] as const,
  tokenByOutcome: ['token-by-outcome'] as const,
  tokenEstimate: ['token-estimate'] as const,
  tokenSummary: ['token-summary'] as const,
  tokenSummaryBy: (groupBy: string) => ['token-summary', groupBy] as const,
}

const organizationMembersKey = ['organization', 'members'] as const
const teamMembersKey = ['teams', 'members'] as const

/** A paged query inherits its resource key and adds its resolved page identity. */
export const paginationKeys = {
  page: (
    resourceKey: readonly unknown[],
    paramsKey: string,
    cursor: string | undefined,
    direction: string | undefined,
    limit: number,
  ) => [...resourceKey, paramsKey, cursor ?? null, direction ?? null, limit] as const,
}

export const organizationKeys = {
  current: ['organization', 'current'] as const,
  invitationTargets: [...organizationMembersKey, 'invitation-targets'] as const,
  memberRoster: (resource: 'members' | 'invitations') =>
    [...organizationMembersKey, resource] as const,
  members: organizationMembersKey,
  memberWorkspaces: (uoaSub?: string) =>
    [...organizationMembersKey, uoaSub ?? 'none', 'workspaces'] as const,
}

export const personalAssistantKeys = {
  all: ['personal-assistant'] as const,
}

export const voiceKeys = {
  all: ['voice'] as const,
  capability: ['voice', 'capability'] as const,
}

export const platformPushKeys = {
  status: ['platform-push', 'status'] as const,
}

export const policyKeys = {
  rules: ['policy-rules'] as const,
}

export const presenceKeys = {
  all: ['presence'] as const,
}

export const projectKeys = {
  all: ['projects'] as const,
  // Nested so the family rule holds. The cost is that create/rename/delete
  // project and add/remove member, which already invalidate `projects`, now
  // also refetch a mounted board — one cheap `GET /api/projects/:id/board`
  // column read. The board payload is `{ style, columns }` and carries no
  // project name, so this is about reachability, not about a rename showing
  // through.
  board: (projectId: string) => ['projects', projectId, 'board'] as const,
  // Deliberately NOT nested (see the header). Insights is a velocity/burndown
  // report built from one query per completed iteration plus a task-event scan,
  // and nothing that invalidates `projects` — rename, delete, membership, board
  // style — can change it. Nesting would re-run the report for no new data.
  insights: (projectId: string) => ['project-insights', projectId] as const,
  // Nested so the project mutations that already refresh `projects` reach the
  // membership list too.
  members: (projectId: string | null) => ['projects', projectId, 'members'] as const,
}

export const runKeys = {
  all: ['runs'] as const,
  active: ['runs', 'active'] as const,
}

export const searchKeys = {
  knowledge: (query: string, mode: string) =>
    ['search', 'knowledge', query, mode] as const,
  messages: (query: string, mode: string) =>
    ['search', 'messages', query, mode] as const,
  thoughts: (query: string, mode: string) =>
    ['search', 'thoughts', query, mode] as const,
}

export const secretKeys = {
  all: ['secrets'] as const,
}

export const statusKeys = {
  all: ['statuses'] as const,
}

export const taskKeys = {
  all: ['tasks'] as const,
  // Deliberately NOT nested (see the header). `optimisticPatch` in the tasks
  // facade sweeps every cache entry under `['tasks']` as `TaskRecord[]` and
  // writes a patched array back; the assignee list is `AssignableUser[]`, so
  // nesting it would hand that sweep a foreign shape and cancel its fetch on
  // every drag.
  assignees: ['task-assignees'] as const,
  documents: (taskId?: string) => ['task-pages', taskId ?? 'none'] as const,
  // Aggregate and per-project boards share the family root, so one invalidate
  // or optimistic write reaches every board at once.
  forProject: (projectId?: string) => ['tasks', projectId ?? 'all'] as const,
}

export const teamKeys = {
  all: ['teams'] as const,
  // Client-only cache-buster for the fixed `/api/team/avatar` URL; nothing
  // fetches it, so it never refetches or resets on its own.
  avatarRevision: ['teams', 'avatar', 'revision'] as const,
  invitations: ['teams', 'invitations'] as const,
  memberCandidates: (search: string) => [...teamMembersKey, 'candidates', search] as const,
  memberRoster: (resource: 'members' | 'invitations') => [...teamMembersKey, resource] as const,
  members: teamMembersKey,
}

export const threadKeys = {
  // The unread/activity projection across every thread. Read-marker writes
  // patch their one cached card; other activity changes reset this key because
  // they can move records across keyset page boundaries.
  activityRoot: ['threads', 'activity'] as const,
  activity: (unreadOnly = false) =>
    ['threads', 'activity', { unreadOnly }] as const,
  unreadDirectMessages: ['threads', 'unread-direct-messages'] as const,
  documentStream: (threadId: string | undefined, sessionId: string) =>
    ['threads', threadId, 'documentStreams', sessionId] as const,
  documentStreams: (threadId?: string) =>
    ['threads', threadId, 'documentStreams'] as const,
  message: (threadId?: string, messageId?: string) =>
    ['threads', threadId, 'message', messageId] as const,
  messages: (threadId?: string) => ['threads', threadId, 'messages'] as const,
  replies: (threadId?: string) => ['threads', threadId, 'replies'] as const,
  repliesOf: (threadId?: string, rootMessageId?: string) =>
    ['threads', threadId, 'replies', rootMessageId] as const,
  runThinking: (threadId: string | undefined, runId: string | null) =>
    ['threads', threadId, 'runs', runId, 'thinking'] as const,
}

export const toolKeys = {
  all: ['tools'] as const,
}

export const triggerKeys = {
  all: ['triggers'] as const,
  // An absent id keeps its slot rather than collapsing to a placeholder, so a
  // disabled render and an enabled one agree on cache identity.
  history: (triggerId: string | undefined, limit: number) =>
    ['triggers', triggerId, 'history', limit] as const,
}

export const userKeys = {
  all: ['users'] as const,
}

export const webPushKeys = {
  config: ['web-push', 'config'] as const,
}

const workflowRunsRoot = ['workflow-runs'] as const

export const workflowKeys = {
  failedRuns: [...workflowRunsRoot, 'failed'] as const,
  installationRuns: (installationId?: string) =>
    ['workflow-installations', installationId, 'runs'] as const,
  installations: ['workflow-installations'] as const,
  installationsForChannel: (channelId?: string) =>
    ['workflow-installations', channelId ?? null] as const,
  installationTriggers: (installationId?: string) =>
    ['workflow-installations', installationId, 'triggers'] as const,
  run: (workflowRunId?: string) => [...workflowRunsRoot, workflowRunId] as const,
  runs: workflowRunsRoot,
  template: (workflowTemplateId?: string) =>
    ['workflow-templates', workflowTemplateId] as const,
  templates: ['workflow-templates'] as const,
  templateStepSamples: (workflowTemplateId?: string) =>
    ['workflow-templates', workflowTemplateId, 'step-samples'] as const,
}

export const mailboxConnectionKeys = {
  list: ['mailbox-connections'] as const,
}

export const browserCloudKeys = {
  connections: ['browser-cloud', 'connections'] as const,
  session: (sessionId?: string) => ['browser-cloud', 'sessions', sessionId] as const,
  threadSessions: (threadId?: string) =>
    ['browser-cloud', 'threads', threadId, 'sessions'] as const,
  agentBrowser: (agentId?: string) => ['browser-cloud', 'agents', agentId] as const,
  myLogins: ['browser-cloud', 'my-logins'] as const,
}
