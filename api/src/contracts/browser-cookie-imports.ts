import { z } from 'zod'

const ExactHttpsOriginSchema = z.string().max(2_048).refine((value) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && url.origin === value
  } catch {
    return false
  }
}, 'Origin must be an exact HTTPS origin without a port.')

const CookieSchema = z.object({
  domain: z.string().min(1).max(255),
  expirationDate: z.number().finite().optional(),
  hostOnly: z.boolean(),
  httpOnly: z.boolean(),
  name: z.string().min(1).max(1_024),
  path: z.string().min(1).max(1_024),
  sameSite: z.enum(['lax', 'no_restriction', 'strict', 'unspecified']),
  secure: z.boolean(),
  session: z.boolean(),
  value: z.string().max(16_384),
}).strict()

export const CreateBrowserCookieImportBodySchema = z.object({
  agentId: z.string().uuid(),
  executorId: z.string().uuid(),
  threadId: z.string().uuid(),
  origins: z.array(ExactHttpsOriginSchema).min(1).max(20).superRefine((value, context) => {
    if (new Set(value).size !== value.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Origins must be distinct.' })
  }),
}).strict()

export const BrowserCookieImportUploadBodySchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  cookies: z.object({
    imports: z.array(z.object({
      cookies: z.array(CookieSchema).max(500),
      origin: ExactHttpsOriginSchema,
    }).strict()).min(1).max(20),
    version: z.literal(1),
  }).strict(),
  executorId: z.string().uuid(),
  payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
  selectedOrigins: z.array(ExactHttpsOriginSchema).min(1).max(20),
  signature: z.string().min(1).max(512),
  submittedAt: z.string().datetime(),
}).strict()

export const BrowserCookieImportPendingBodySchema = z.object({
  connectionEpoch: z.string().regex(/^\d+$/),
  executorId: z.string().uuid(),
  observedAt: z.string().datetime(),
  signature: z.string().min(1).max(512),
}).strict()
