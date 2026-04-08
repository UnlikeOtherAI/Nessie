import type { AuthorizedActionContext } from '@nessie/schemas'

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean
  }

  interface FastifyRequest {
    actorContext: AuthorizedActionContext | null
  }
}
