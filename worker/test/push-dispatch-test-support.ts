import crypto from 'node:crypto'
import { AT_REST_SECRET_PURPOSE, encryptWithKeyRing } from '@nessie/runtime'
import type { PushPayload, PushResult, PushTarget } from '@nessie/push'
import type { PushDispatchPrisma, PushSenders } from '../src/control/push-dispatch.js'
import type {
  ApnsCredentials,
  FcmCredentials,
} from '@nessie/push'

const AUTH_SECRET = 'test-auth-secret'
const ENCRYPTION_KEY_RING = {
  activeVersion: 'test-key',
  keys: { 'test-key': 'test-at-rest-encryption-root' },
  legacyKey: AUTH_SECRET,
} as const

type CredRow = {
  provider: 'apns' | 'fcm'
  secretRef: string
  apnsKeyId: string | null
  apnsTeamId: string | null
  apnsTopic: string | null
  apnsEnvironment: 'sandbox' | 'production' | null
}

type TokenRow = {
  id: string
  userId: string
  token: string
  platform: 'ios' | 'android'
  apnsEnvironment?: 'sandbox' | 'production'
}

type SecretRow = { ref: string; ciphertext: string; iv: string; authTag: string }
type MemberRow = { userId: string; muted: boolean }
type UserRow = { id: string; preferences: unknown; displayName?: string }
type DeliveryRow = {
  organizationId: string
  userId: string
  messageId: string | null
  provider: 'apns' | 'fcm'
  status: 'sent' | 'failed' | 'dead'
  errorCode: string | null
  attempts: number
}
type SurfaceViewer = {
  channelId: string | null
  kind: 'channel' | 'ops_usage'
  rootMessageId: string | null
  threadId: string | null
  userId: string
}

const encrypt = (plaintext: string): Omit<SecretRow, 'ref'> =>
  encryptWithKeyRing(ENCRYPTION_KEY_RING, AT_REST_SECRET_PURPOSE.pushCredential, plaintext)

type FakeMessage = {
  agent: { name: string } | null
  agentId: string | null
  basisScopes: { scopeId: string; scopeType: string }[]
  user: { displayName: string } | null
}

type FakeState = {
  creds: CredRow[]
  members: MemberRow[]
  users?: UserRow[]
  tokens: TokenRow[]
  secrets: SecretRow[]
  channel: { label: string } | null
  message?: FakeMessage | null
  disclosureGrants?: { grantedByUserId: string }[]
  activeOrganizationMemberIds?: string[]
  deleted: string[]
  deliveries?: DeliveryRow[]
  unreadAttentionCount?: number
  unreadMessageCount?: number
  surfaceViewers?: SurfaceViewer[]
}

const member = (userId: string, muted = false): MemberRow => ({ userId, muted })

const makeFakePrisma = (state: FakeState): PushDispatchPrisma =>
  ({
    // The exactly-once claim (`push_send_claims`). A fresh fake always wins it;
    // the losing side is proved against the real unique index in
    // `test/db/push-dispatch-idempotency.test.ts`.
    $executeRaw: async () => 1,
    agent: {
      findMany: async () => [],
    },
    pushCredential: {
      findMany: async () => state.creds,
    },
    channelMember: {
      findMany: async ({ where }: {
        where: { userId: string | { in?: string[]; not?: string } }
      }) => {
        if (typeof where.userId === 'string') {
          return state.members
            .filter((member) => member.userId === where.userId)
            .map((member) => ({ channelId: 'channel-1', ...member }))
        }
        return state.members.filter((member) =>
          where.userId.in
            ? where.userId.in.includes(member.userId)
            : member.userId !== where.userId.not,
        )
      },
    },
    deviceToken: {
      findMany: async ({
        where,
      }: {
        where: { organizationId: string; userId: { in: string[] } }
      }) =>
        state.tokens.filter((token) => where.userId.in.includes(token.userId)),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        state.deleted.push(...where.id.in)
        state.tokens = state.tokens.filter((t) => !where.id.in.includes(t.id))
        return { count: where.id.in.length }
      },
    },
    channel: {
      findUnique: async () => state.channel,
    },
    message: {
      findUnique: async () => state.message ?? {
        agent: null,
        agentId: null,
        basisScopes: [],
        user: (() => {
          const author = (state.users ?? []).find((entry) => entry.id === 'author-1')
          return author ? { displayName: author.displayName ?? author.id } : null
        })(),
      },
    },
    teamMember: { findMany: async () => [] },
    projectMember: { findMany: async () => [] },
    organizationMember: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        state.activeOrganizationMemberIds === undefined
        || state.activeOrganizationMemberIds.includes(where.userId)
          ? { id: 'active-membership' }
          : null,
    },
    organization: { findUnique: async () => ({ externalOrgId: null }) },
    productAccountLink: { findUnique: async () => null },
    disclosureGrant: { findMany: async () => state.disclosureGrants ?? [] },
    scopeDisclosureGrant: { findMany: async () => [] },
    mcpOAuthSecret: {
      findUnique: async ({ where }: { where: { ref: string } }) =>
        state.secrets.find((s) => s.ref === where.ref) ?? null,
    },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const users = state.users ?? state.members.map((m) => ({ id: m.userId, preferences: null }))
        return users.filter((user) => where.id.in.includes(user.id))
      },
      findUnique: async ({ where }: { where: { id: string } }) => {
        const user = (state.users ?? []).find((entry) => entry.id === where.id)
        return user ? { displayName: user.displayName ?? user.id } : null
      },
    },
    pushDelivery: {
      create: async ({ data }: { data: DeliveryRow }) => {
        state.deliveries?.push(data)
        return { id: crypto.randomUUID(), createdAt: new Date(), ...data }
      },
    },
    $queryRaw: async () => [{ unread_count: state.unreadMessageCount ?? 0 }],
    userAlert: {
      count: async () => state.unreadAttentionCount ?? 0,
    },
    userPushSurfacePresence: {
      findMany: async ({ where }: {
        where: {
          channelId: string | null
          rootMessageId: string | null
          surfaceKind: string
          threadId: string | null
          userId: { in: string[] }
        }
      }) =>
        (state.surfaceViewers ?? [])
          .filter((viewer) =>
            where.userId.in.includes(viewer.userId)
            && viewer.kind === where.surfaceKind
            && viewer.channelId === where.channelId
            && viewer.rootMessageId === where.rootMessageId
            && viewer.threadId === where.threadId,
          )
          .map((viewer) => ({ userId: viewer.userId })),
    },
  }) as unknown as PushDispatchPrisma

const recordingSenders = (): {
  senders: PushSenders
  apnsCalls: PushTarget[]
  fcmCalls: PushTarget[]
  apnsPayloads: PushPayload[]
  apnsCredentials: ApnsCredentials[]
  fcmPayloads: PushPayload[]
  results: Map<string, PushResult>
} => {
  const apnsCalls: PushTarget[] = []
  const fcmCalls: PushTarget[] = []
  const apnsPayloads: PushPayload[] = []
  const apnsCredentials: ApnsCredentials[] = []
  const fcmPayloads: PushPayload[] = []
  const results = new Map<string, PushResult>()
  const okResult: PushResult = { ok: true, status: 200, deadToken: false }
  const senders: PushSenders = {
    sendApns: async (credentials: ApnsCredentials, target, p: PushPayload) => {
      apnsCalls.push(target)
      apnsPayloads.push(p)
      apnsCredentials.push(credentials)
      return results.get(target.token) ?? okResult
    },
    sendFcm: async (_c: FcmCredentials, target, p: PushPayload) => {
      fcmCalls.push(target)
      fcmPayloads.push(p)
      return results.get(target.token) ?? okResult
    },
  }
  return { senders, apnsCalls, fcmCalls, apnsPayloads, apnsCredentials, fcmPayloads, results }
}

const apnsCred = (): CredRow => ({
  provider: 'apns',
  secretRef: 'secret_push_apns',
  apnsKeyId: 'KEY123',
  apnsTeamId: 'TEAM123',
  apnsTopic: 'com.example.app',
  apnsEnvironment: 'production',
})

const fcmCred = (): CredRow => ({
  provider: 'fcm',
  secretRef: 'secret_push_fcm',
  apnsKeyId: null,
  apnsTeamId: null,
  apnsTopic: null,
  apnsEnvironment: null,
})

const apnsSecret = (): SecretRow => ({ ref: 'secret_push_apns', ...encrypt('-----P8-----') })
const fcmSecret = (): SecretRow => ({
  ref: 'secret_push_fcm',
  ...encrypt('{"type":"service_account"}'),
})

const payload = (over: Record<string, unknown> = {}) => ({
  messageId: 'message-1',
  authorUserId: 'author-1',
  channelId: 'channel-1',
  threadId: 'thread-1',
  organizationId: 'org-1',
  contentSnippet: 'hello world',
  mentionUserIds: [],
  ...over,
})


export {
  ENCRYPTION_KEY_RING,
  apnsCred,
  apnsSecret,
  fcmCred,
  fcmSecret,
  makeFakePrisma,
  member,
  payload,
  recordingSenders,
}
