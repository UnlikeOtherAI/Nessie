/**
 * Initials for a display name.
 *
 * The implementation lives with the tile that draws it
 * (`lib/identity-shape.ts`) so shape and fallback stay one
 * decision; this re-export keeps the many existing import sites working.
 *
 * The agent gradient and the indexed DM gradients that used to live here are
 * gone. They were a second identity palette competing with
 * `AGENT_AVATAR_BACKGROUND_COLORS`, which is why one agent was a flat purple
 * tile in the sidebar and a palette-coloured portrait in the channel; the DM
 * gradients had no reader at all.
 */
export { identityInitials as getInitials } from './identity-shape'
