import type { VoiceDeviceCredential } from '@prisma/client'
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
  }

  interface FastifyRequest {
    actorContext: AuthorizedActionContext | null
    /**
     * Set only when the request authenticated with a voice device credential.
     * A route that must behave differently for the phone reads this; a route
     * that does not care sees an ordinary actor context either way.
     */
    voiceCredential?: VoiceDeviceCredential
  }
}
