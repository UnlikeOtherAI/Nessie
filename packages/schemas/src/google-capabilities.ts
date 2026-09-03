import { z } from 'zod'

/**
 * The Google capability catalog — the single source of truth for which OAuth
 * scopes Nessie may request, what each one lets an agent do, and how much
 * verification burden it carries. The API builds authorize URLs from it, the
 * worker preflights tool calls against it, and the admin renders its copy.
 *
 * A capability is a *product* concept ("send email as you"); a scope is
 * Google's. The mapping is one-to-many and deliberately explicit: never derive
 * a capability from a raw scope string at a call site, and never hardcode a
 * scope anywhere else.
 *
 * See docs/plans/2026-08-31-google-workspace-email-calendar.md §3.
 */

export const GoogleCapabilityIdSchema = z.enum([
  'gmail.read',
  'gmail.compose',
  'gmail.send',
  'gmail.modify',
  'calendar.read',
  'calendar.freebusy',
  'calendar.write',
  'meet.create',
  'contacts.read',
])
export type GoogleCapabilityId = z.infer<typeof GoogleCapabilityIdSchema>

/**
 * Google's own verification tiers. `restricted` scopes require a CASA security
 * assessment for a public OAuth client; the internal-use exception applies only
 * when every user belongs to the same Team/Cloud Identity organization,
 * the Cloud project is owned by that organization, AND the consent screen is
 * Internal — not merely because the deployment is self-hosted.
 */
export type GoogleScopeTier = 'basic' | 'sensitive' | 'restricted'

export type GoogleCapability = {
  id: GoogleCapabilityId
  /** Every scope that must be granted for the capability to be usable. */
  scopes: readonly string[]
  label: string
  /** One plain sentence, shown verbatim on the consent and scope-request cards. */
  explains: string
  risk: 'read' | 'write' | 'send'
  tier: GoogleScopeTier
}

/**
 * Identity scopes are requested on every connect so the account can be
 * identified from the OIDC `id_token` rather than from a Gmail API call — a
 * Calendar-only or send-only connection has no Gmail read scope and must still
 * resolve its own identity.
 */
export const GOOGLE_IDENTITY_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
]

export const GOOGLE_CAPABILITIES: readonly GoogleCapability[] = [
  {
    id: 'gmail.read',
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    label: 'Read your email',
    explains:
      'Search and read your messages, threads, labels and attachments.',
    risk: 'read',
    tier: 'restricted',
  },
  {
    id: 'gmail.compose',
    // Google has no drafts-but-cannot-send scope: gmail.compose grants both.
    // The draft/send separation is enforced by Nessie's structural send gate,
    // never by OAuth, and the consent copy says so rather than implying Google
    // is holding the line.
    scopes: ['https://www.googleapis.com/auth/gmail.compose'],
    label: 'Write drafts and send email as you',
    explains:
      'Create and edit drafts, and send them as you. Google grants drafting '
      + 'and sending together; Nessie still asks before anything is sent.',
    risk: 'send',
    tier: 'restricted',
  },
  {
    id: 'gmail.send',
    // Send-only. Cannot create or send a *draft*: users.drafts.create and
    // users.drafts.send accept gmail.compose or gmail.modify only.
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    label: 'Send email as you (no draft, no reading)',
    explains:
      'Send a message directly as you. Cannot read your mail and cannot use '
      + 'drafts.',
    risk: 'send',
    tier: 'sensitive',
  },
  {
    id: 'gmail.modify',
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    label: 'Organise your email',
    explains: 'Apply labels, archive, and move messages to trash.',
    risk: 'write',
    tier: 'restricted',
  },
  {
    id: 'calendar.read',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    label: 'Read your calendar',
    explains: 'List your calendars and read event details.',
    risk: 'read',
    tier: 'sensitive',
  },
  {
    id: 'calendar.freebusy',
    // Its own narrow scope: bundling availability under calendar.readonly
    // would hand out event contents to answer "when am I free".
    scopes: ['https://www.googleapis.com/auth/calendar.freebusy'],
    label: 'See when you are free',
    explains:
      'Read only your busy/free blocks — never event titles, guests or notes.',
    risk: 'read',
    tier: 'sensitive',
  },
  {
    id: 'calendar.write',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    label: 'Manage calendar events',
    explains:
      'Create, update and cancel events, and invite guests. This also grants '
      + 'reading event details.',
    risk: 'write',
    tier: 'sensitive',
  },
  {
    id: 'meet.create',
    scopes: ['https://www.googleapis.com/auth/meetings.space.created'],
    label: 'Create Google Meet links',
    explains: 'Create a Meet space so a call can be started for you.',
    risk: 'write',
    tier: 'sensitive',
  },
  {
    id: 'contacts.read',
    scopes: [
      'https://www.googleapis.com/auth/contacts.readonly',
      'https://www.googleapis.com/auth/directory.readonly',
    ],
    label: 'Look up your contacts',
    explains:
      'Resolve a name you mention to an email address, from your contacts and '
      + 'your organisation directory.',
    risk: 'read',
    tier: 'sensitive',
  },
]

const BY_ID = new Map<GoogleCapabilityId, GoogleCapability>(
  GOOGLE_CAPABILITIES.map((capability) => [capability.id, capability]),
)

export const getGoogleCapability = (
  id: GoogleCapabilityId,
): GoogleCapability => {
  const capability = BY_ID.get(id)
  if (!capability) {
    // Unreachable while the enum and the table agree; a loud throw beats a
    // silent undefined that would widen or narrow a scope request.
    throw new Error(`[google-capabilities] unknown capability ${id}`)
  }
  return capability
}

/**
 * The default set when a caller names none — today's behaviour before the
 * catalog existed, so an unchanged client connects byte-identically.
 */
export const DEFAULT_GOOGLE_CAPABILITIES: readonly GoogleCapabilityId[] = [
  'gmail.read',
  'meet.create',
]

/** Every scope for a capability set, de-duplicated, plus identity scopes. */
export const scopesForCapabilities = (
  ids: readonly GoogleCapabilityId[],
): string[] => {
  const scopes = new Set<string>(GOOGLE_IDENTITY_SCOPES)
  for (const id of ids) {
    for (const scope of getGoogleCapability(id).scopes) {
      scopes.add(scope)
    }
  }
  return [...scopes]
}

/**
 * Whether every scope a capability needs is present in `grantedScopes`.
 *
 * All-of, never any-of: `contacts.read` needs two scopes and a user may grant
 * one. The caller passes what Google actually returned — never what was asked
 * for — because Google's consent screen lets a person un-tick individual
 * scopes.
 */
export const capabilityIsGranted = (
  id: GoogleCapabilityId,
  grantedScopes: readonly string[],
): boolean => {
  const granted = new Set(grantedScopes)
  return getGoogleCapability(id).scopes.every((scope) => granted.has(scope))
}

/**
 * The capabilities a connection can actually exercise: granted at Google AND
 * not locally blocked. Google cannot partially revoke a grant, so a local block
 * is how a person removes one capability without disconnecting — which means
 * the block has to be enforced on every read of this list, not just in the UI.
 */
export const usableCapabilities = (input: {
  grantedScopes: readonly string[]
  disabledCapabilities: readonly GoogleCapabilityId[]
}): GoogleCapabilityId[] => {
  const blocked = new Set(input.disabledCapabilities)
  return GOOGLE_CAPABILITIES.filter(
    (capability) =>
      !blocked.has(capability.id)
      && capabilityIsGranted(capability.id, input.grantedScopes),
  ).map((capability) => capability.id)
}

/** Parse a caller-supplied capability list, rejecting anything unknown. */
export const GoogleCapabilityListSchema = z
  .array(GoogleCapabilityIdSchema)
  .min(1)
  .max(GOOGLE_CAPABILITIES.length)
