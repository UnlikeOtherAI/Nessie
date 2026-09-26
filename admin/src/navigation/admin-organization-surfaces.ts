import type { Surface } from './page-types'
import {
  toAdmin,
  toOrganizationSecurity,
  toTeams,
  toToolRegistry,
} from './surface-parents'

// The Admin section's second and third sidebar groups: the organisation's
// administration (People, Teams, Organisation, AI models, Company connections,
// Keys, Usage and limits, Credits and billing, Security) and the collapsed
// Advanced group (Tool registry, Access rules, System health, Mobile push
// setup, Session debug). Every page is one step in from Admin; the three that
// open a record push one step further.
export const createAdminOrganizationSurfaces = (adminRoot: string): Surface[] => [
  {
    // One roster behind the scope switch — the organisation, or a team the
    // viewer is in — with the roster's own status strip and the automatic
    // team access rule a health alert points at.
    depth: 1,
    intent: { state: ['scope', 'tab', 'automaticMembershipRule'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/people$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/admin\/teams$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // One team, pushed from the Teams list. Its two sections, General and
    // Overrides, are a tab strip; what the team overrides is changed on the
    // Organisation pages at its scope, which its rows open.
    depth: 2,
    identityOf: (match) => `team:${match[1]}`,
    intent: { state: ['tab'] },
    keyScope: () => 'team',
    parentOf: toTeams,
    pattern: /^\/admin\/teams\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // Every organisation page shares one screen identity, so page A → page B
    // swaps in place. These three are one page per concern behind the scope
    // switch (`?scope=organisation|team:<id>`): AI models with its catalogue
    // filters (`modelProvider`, never the `provider` Connected accounts
    // consumes), and Keys with its status strip.
    depth: 1,
    intent: { state: ['scope', 'status', 'model', 'modelProvider'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/(?:models|connections|keys)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    intent: { state: ['tab'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/(?:organisation|usage|security)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // The billing service sends a checkout back here with its outcome.
    depth: 1,
    intent: { consume: ['uoa_billing'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/billing$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // One program signed in as somebody, pushed from Security's list.
    depth: 2,
    identityOf: (match) => `paired-agent:${match[1]}`,
    keyScope: () => 'paired-agent',
    parentOf: toOrganizationSecurity,
    pattern: /^\/admin\/security\/programs\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },

  // ── Advanced ─────────────────────────────────────────────────────────────
  {
    depth: 1,
    intent: { state: ['status', 'source', 'search', 'instance', 'deepWaterInstance'] },
    parentOf: toAdmin,
    pattern: /^\/admin\/advanced\/tools$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    // One tool, pushed from the Tool registry.
    depth: 2,
    identityOf: (match) => `tool:${match[1]}`,
    keyScope: () => 'tool',
    parentOf: toToolRegistry,
    pattern: /^\/admin\/advanced\/tools\/([^/]+)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
  {
    depth: 1,
    parentOf: toAdmin,
    pattern: /^\/admin\/advanced\/(?:access-rules|announcements|health|push|debug)$/,
    root: adminRoot,
    section: 'admin',
    type: 'detail',
  },
]
