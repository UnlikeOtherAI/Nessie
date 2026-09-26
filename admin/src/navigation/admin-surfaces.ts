import type { Surface } from './page-types'
import {
  toAdmin,
  toAgents,
  toApps,
  toAutomations,
  toComputerSessions,
  toComputers,
} from './surface-parents'

// The Admin section: `/admin` is its root — on a phone the sidebar list is the
// page, on a wider layout the route forwards to Agents — and the first sidebar
// group, Agents, is everyone's: Agents, Apps, Computers and Automations. The
// organisation's administration is the next file's
// (`admin-organisation-surfaces.ts`); `/alerts` and `/feedback` close this one,
// because they are reached from every section and belong to none of its groups.
export const createAdminSurfaces = (adminRoot: string): Surface[] => [
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/admin$/,
    root: adminRoot,
    section: 'admin',
    type: 'root',
  },

  // ── Agents ───────────────────────────────────────────────────────────────
  {
    depth: 1,
    intent: { state: ['scope'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/agents$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `designer:${match[1] ?? 'new'}`,
    keyScope: () => 'agent-designer',
    intent: { state: ['designerSection', 'designerMode', 'visibility', 'parentId'] },
    parentOf: toAgents,
    pattern: /^\/admin\/agents\/designer(?:\/([^/]+))?$/,
    root: adminRoot,
    section: 'admin',
    type: 'flow',
  },
  {
    // Depth 3 under the agent: Back lands on the owner of this mailbox, and a
    // conversation query survives a reload.
    depth: 3,
    identityOf: (match) => `agent-mailbox:${match[1]}`,
    intent: { state: ['conversation', 'mailboxFilter'] },
    keyScope: () => 'agent-mailbox',
    parentOf: (match) => ({
      label: 'Back to agent',
      pathname: `/admin/agents/${match[1]}`,
    }),
    pattern: /^\/admin\/agents\/([^/]+)\/mailbox$/,
    root: adminRoot,
    section: 'admin',
    type: 'nested',
  },
  {
    // `designer` is the flow above, never an agent id.
    depth: 2,
    identityOf: (match) => `agent:${match[1]}`,
    keyScope: () => 'agent',
    intent: { state: ['agentTab'] },
    parentOf: toAgents,
    pattern: /^\/admin\/agents\/(?!designer$)([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },

  // ── Apps ─────────────────────────────────────────────────────────────────
  {
    depth: 1,
    intent: { state: ['filter'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/apps$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `app:${match[1]}`,
    keyScope: () => 'app',
    intent: { consume: ['connect'], state: ['tab'] },
    parentOf: toApps,
    pattern: /^\/admin\/apps\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'nested',
  },

  // ── Computers ────────────────────────────────────────────────────────────
  {
    // The pairing doorways (`?create=`, a project's `scopeProjectId`, a
    // review link's `#confirmationToken=`) are one-shot; a prepared change it
    // is showing is state, not history.
    depth: 1,
    intent: {
      consume: ['create', 'scopeProjectId'],
      hash: ['confirmationToken'],
      state: ['accessChange', 'promotion'],
    },
    parentOf: toAdmin,
    pattern: /^\/admin\/computers$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: () => 'computer-sessions',
    keyScope: () => 'computer-sessions',
    parentOf: toComputers,
    pattern: /^\/admin\/computers\/sessions$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 3,
    identityOf: (match) => `computer-session:${match[1]}:${match[2]}`,
    keyScope: () => 'computer-session',
    parentOf: toComputerSessions,
    pattern: /^\/admin\/computers\/([^/]+)\/sessions\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // One paired machine, pushed from the Computers table. `sessions` is the
    // list above, never a machine id.
    depth: 2,
    identityOf: (match) => `computer:${match[1]}`,
    intent: { state: ['tab'] },
    keyScope: () => 'computer',
    parentOf: toComputers,
    pattern: /^\/admin\/computers\/(?!sessions$)([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },

  // ── Automations ──────────────────────────────────────────────────────────
  {
    // One page, three tabs: Schedules & triggers, Batch jobs, Workflows. Each
    // tab keeps the filters and selections it had as a page of its own; the
    // workflow browser's column stages are state, not routes.
    depth: 1,
    intent: {
      consume: ['create'],
      state: [
        'tab', 'status', 'search', 'type',
        'template', 'installation', 'run', 'failedRuns', 'demonstrationDrafts',
      ],
    },
    parentOf: toAdmin,
    pattern: /^\/admin\/automations$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `trigger:${match[1]}`,
    keyScope: () => 'trigger',
    parentOf: toAutomations,
    pattern: /^\/admin\/automations\/triggers\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: () => 'task-set:new',
    intent: { state: ['sourcePageId', 'sourceVersionId', 'format'] },
    keyScope: () => 'task-set-create',
    parentOf: toAutomations,
    pattern: /^\/admin\/automations\/batch-jobs\/new$/,
    root: adminRoot,
    section: 'admin',
    type: 'flow',
  },
  {
    // `new` is the creation flow above, never a batch job's id.
    depth: 2,
    identityOf: (match) => `task-set:${match[1]}`,
    intent: { state: ['item'] },
    keyScope: () => 'task-set',
    parentOf: toAutomations,
    pattern: /^\/admin\/automations\/batch-jobs\/(?!new$)([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `workflow-designer:${match[1] ?? 'new'}`,
    keyScope: () => 'workflow-designer',
    parentOf: toAutomations,
    pattern: /^\/admin\/automations\/workflows\/designer(?:\/([^/]+))?$/,
    root: adminRoot,
    section: 'admin',
    type: 'flow',
  },

  // ── Reached from every section ───────────────────────────────────────────
  {
    // The bell and the account menu open these from anywhere, so Back returns
    // to the reader's origin and falls back to Admin on a cold deep link.
    depth: 1,
    parent: 'origin',
    parentOf: toAdmin,
    pattern: /^\/(?:alerts|feedback)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
]
