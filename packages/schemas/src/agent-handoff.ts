import { z } from 'zod'

/**
 * `agent_handoff` — passing a conversation to a global agent.
 *
 * v1 targets registry slugs only: handing off to an arbitrary agent is a
 * different feature (a bounded agent-to-agent conversation) and stays out. The
 * slug is validated against the live blueprint registry at call time; the schema
 * only fixes its shape.
 *
 * Spec: docs/plans/2026-09-02-agent-designer-global-agent.md (D8).
 */

/**
 * The Agent Designer's blueprint slug.
 *
 * The blueprint itself lives in `@nessie/team-admin` (it holds a Prisma
 * client's worth of dependencies), but its slug is a plain contract that the
 * admin needs too: `AgentRecord.systemSlug` is how a client says "this is the
 * Agent Designer" structurally instead of matching a display name.
 */
export const AGENT_DESIGNER_SLUG = 'agent-designer'

const GlobalAgentSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'A global-agent slug is lowercase letters, digits and hyphens.')

export const AgentHandoffToolInputSchema = z.object({
  target: GlobalAgentSlugSchema,
  brief: z.string().trim().min(1).max(4000),
})
export type AgentHandoffToolInput = z.infer<typeof AgentHandoffToolInputSchema>

export const AgentHandoffToolOutputSchema = z.object({
  /**
   * `handed_off` wrote a fresh briefing; `already_open` converged on the one
   * still inside its cooldown. The model is told which so it can say "I've sent
   * this over" or "that is already waiting for you there" truthfully.
   */
  status: z.enum(['handed_off', 'already_open']),
  target: GlobalAgentSlugSchema,
  targetName: z.string(),
  channelId: z.string().uuid(),
})
export type AgentHandoffToolOutput = z.infer<typeof AgentHandoffToolOutputSchema>

/**
 * The hidden `system` brief written into the target's home DM. Server-authored
 * provenance only — the model supplies the prose, never these ids.
 */
export const AgentHandoffBriefMetadataSchema = z.object({
  fromAgentId: z.string().uuid(),
  originChannelId: z.string().uuid(),
  originThreadId: z.string().uuid(),
  originRunId: z.string().uuid(),
  requestedByUserId: z.string().uuid(),
  targetSlug: GlobalAgentSlugSchema,
})
export type AgentHandoffBriefMetadata = z.infer<typeof AgentHandoffBriefMetadataSchema>

/**
 * The other brief a global agent can receive: a form draft handed over from the
 * Agent Designer page's sidebar ("Continue in chat", D9).
 *
 * Same shape of act as a handoff and the same delivery — a hidden `system`
 * message that starts the run — so it carries its own server-authored
 * provenance rather than arriving as an anonymous instruction, and the person's
 * unsaved draft is never written as a `user` turn under their id.
 */
export const GlobalAgentDraftMetadataSchema = z.object({
  source: z.literal('designer_form'),
  requestedByUserId: z.string().uuid(),
  targetSlug: GlobalAgentSlugSchema,
  /** Present when the draft was an edit of an existing agent, not a new one. */
  editingAgentId: z.string().uuid().optional(),
})
export type GlobalAgentDraftMetadata = z.infer<typeof GlobalAgentDraftMetadataSchema>

/**
 * The doorway left behind in the origin thread: an ordinary agent-authored
 * message whose metadata carries the deep link, rendered by the client as an
 * internal navigation affordance.
 *
 * Deliberately not an interactive card: card `link` blocks require an absolute
 * https URL, card actions carry no navigation, and a pressable card belonging to
 * a run that has ended would re-enter the wake machinery.
 */
export const AgentHandoffDoorwayMetadataSchema = z.object({
  channelId: z.string().uuid(),
  threadId: z.string().uuid(),
  targetSlug: GlobalAgentSlugSchema,
  targetName: z.string().min(1),
})
export type AgentHandoffDoorwayMetadata = z.infer<typeof AgentHandoffDoorwayMetadataSchema>
