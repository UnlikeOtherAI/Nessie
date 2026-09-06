import type { Surface } from './page-types'
import {
  toAdmin,
  toAgents,
  toApps,
  toStatuses,
  toWorkflows,
} from './surface-parents'

export const createAdminSurfaces = (adminRoot: string): Surface[] => [
  {
    contextualList: true,
    depth: 0,
    pattern: /^\/settings$/,
    root: adminRoot,
    section: 'admin',
    type: 'root',
  },
  {
    depth: 2,
    identityOf: (match) => `status:${match[1]}`,
    keyScope: () => 'status',
    parentOf: toStatuses,
    pattern: /^\/settings\/statuses\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    splitInline: true,
    type: 'nested',
  },
  {
    // Every settings page shares one screen identity, so page A → page B swaps
    // in place exactly as it does today.
    depth: 1,
    intent: { state: ['tab'] },
    parentOf: toAdmin,
    pattern: /^\/settings\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // The team roster and the team/organisation Secrets pages are direct
    // sibling doorways of their organisation counterparts, not tabs nested
    // inside `/settings/team` or `/settings/organization`.
    depth: 1,
    intent: { state: ['tab'] },
    parentOf: toAdmin,
    pattern: /^\/settings\/(?:team\/(?:members|secrets)|organization\/secrets)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    intent: { state: ['scope'] },
    parentOf: toAdmin,
    pattern: /^\/agents$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 2,
    identityOf: (match) => `designer:${match[1] ?? 'new'}`,
    keyScope: () => 'agent-designer',
    intent: { state: ['parentId'] },
    parentOf: toAgents,
    pattern: /^\/agents\/designer(?:\/([^/]+))?$/,
    root: adminRoot,
    section: 'admin',
    type: 'flow',
  },
  {
    depth: 2,
    identityOf: (match) => `workflow-designer:${match[1] ?? 'new'}`,
    keyScope: () => 'workflow-designer',
    parentOf: toWorkflows,
    pattern: /^\/agents\/workflow-designer(?:\/([^/]+))?$/,
    root: adminRoot,
    section: 'admin',
    type: 'flow',
  },
  {
    // The automation browsers' column stages are state, not routes.
    depth: 1,
    intent: {
      consume: ['create', 'scopeProjectId'],
      hash: ['confirmationToken', 'trigger'],
      state: [
        'executorId', 'accessChange', 'promotion', 'tab',
        'status', 'search', 'source', 'instance', 'deepWaterInstance',
      ],
    },
    parentOf: toAdmin,
    pattern: /^\/agents\/(?:workflows|triggers|tools|executors)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
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
      pathname: `/agents/${match[1]}`,
    }),
    pattern: /^\/agents\/([^/]+)\/mailbox$/,
    root: adminRoot,
    section: 'admin',
    type: 'nested',
  },
  {
    // Dynamic agent id last, mirroring the router's own ranking.
    depth: 2,
    identityOf: (match) => `agent:${match[1]}`,
    keyScope: () => 'agent',
    intent: { state: ['agentTab'] },
    parentOf: toAgents,
    pattern: /^\/agents\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    intent: { state: ['filter'] },
    parentOf: toAdmin,
    pattern: /^\/apps$/,
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
    pattern: /^\/apps\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'nested',
  },
  {
    // Governance and billing pages sit beside settings, one step in from Admin.
    depth: 1,
    intent: { consume: ['uoa_billing'] },
    parentOf: toAdmin,
    pattern: /^\/(?:audit|approvals|tokens|policy)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // Reached from any section, so Back returns to the reader's origin and
    // falls back to Admin on a cold deep link.
    depth: 1,
    parent: 'origin',
    parentOf: toAdmin,
    pattern: /^\/(?:alerts|feedback)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/ops$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // `/ops` is super-admin-only; this owner-only page never falls back there.
    depth: 2,
    parent: 'origin',
    parentOf: toAdmin,
    pattern: /^\/ops\/usage$/,
    root: adminRoot,
    section: 'admin',
    type: 'nested',
  },
]
