import type { AgentAccessCredential, VoiceDeviceCredential } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean
    /**
     * This route also accepts the voice-scoped device credential.
     *
     * Nessie has no generic route-scoping machinery, so the scope *is* this
     * flag: a credential the native app holds during a call reaches exactly
     * the routes that opt in, and every other route rejects it the way it
     * rejects any unknown bearer. Declared per route rather than by path
     * prefix, so widening the scope is a visible edit at the route itself.
     */
    voiceCredential?: boolean
    /**
     * This route also accepts an agent access credential (`nag1_`).
     *
     * Same mechanism and same reason as `voiceCredential`: the flag IS the
     * scope. A credential an agent holds reaches exactly the routes that opt
     * in — in practice the MCP endpoint — and every other route rejects it,
     * so lending an agent a foothold never quietly lends it the whole API.
     */
    agentCredential?: boolean
  }

  interface FastifyRequest {
    actorContext: AuthorizedActionContext | null
    /**
     * Set only when the request authenticated with a voice device credential.
     * A route that must behave differently for the phone reads this; a route
     * that does not care sees an ordinary actor context either way.
     */
    voiceCredential?: VoiceDeviceCredential
    /**
     * Set only when the request authenticated with an agent access credential.
     * The MCP endpoint reads its `scopes` to decide which tools it may run;
     * the actor context beside it is an ordinary one for the granting human.
     */
    agentCredential?: AgentAccessCredential
  }
}
