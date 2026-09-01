import type { FastifyReply, FastifyRequest } from 'fastify'
import type { UoaSessionIdentity } from '@nessie/schemas'

import type { UoaSessionExchange } from '../services/uoa-session.js'

export type IssueRefreshCookie = (
  request: FastifyRequest,
  reply: FastifyReply,
  params: {
    expectedPasswordHash?: string
    organizationId: string
    providerId: string
    providerType: string
    sessionId: string
    uoaSession?: {
      exchange: UoaSessionExchange
      identity: UoaSessionIdentity
    }
    userId: string
  },
) => Promise<void>
