import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import Fastify from 'fastify'
import type { PrismaClient } from '@prisma/client'
import type { AuthorizedActionContext } from '@nessie/schemas'
import type { PinnedFetch } from '@nessie/runtime'
import { registerTeamMembersRoutes } from '../src/routes/team-members.js'

export const organizationId = '00000000-0000-4000-8000-000000000001'
export const otherOrganizationId = '00000000-0000-4000-8000-000000000099'
const projectId = '00000000-0000-4000-8000-000000000002'
export const teamId = '00000000-0000-4000-8000-000000000003'
export const localTeamId = '00000000-0000-4000-8000-000000000004'
const userId = '00000000-0000-4000-8000-00000000000a'
export const externalOrgId = 'org_acme'
export const externalTeamId = 'team_design'
const uoaPrivateKeyPem = String(
  generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }),
)

export const uoaEnv = {
  UOA_BASE_URL: 'https://uoa.test',
  UOA_CLIENT_SECRET: 'test-client-secret',
  UOA_CONFIG_JWT_KID: 'test-kid',
  UOA_CONFIG_JWT_PRIVATE_KEY_B64: Buffer.from(uoaPrivateKeyPem).toString('base64'),
  UOA_CONFIG_URL: 'https://nessie.test/uoa/config.jwt',
  UOA_DOMAIN: 'nessie.test',
  UOA_JWKS_URL: 'https://nessie.test/.well-known/jwks.json',
  UOA_REDIRECT_URL: 'https://nessie.test/auth/callback',
}

export const withUoaEnv = async (run: () => Promise<void>): Promise<void> => {
  const previous = { ...process.env }
  Object.assign(process.env, uoaEnv)
  try {
    await run()
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
}

type TeamRow = {
  id: string
  organizationId: string
  externalOrgId: string | null
  externalTeamId: string | null
}

const teams: TeamRow[] = [
  { id: teamId, organizationId, externalOrgId, externalTeamId: externalTeamId },
  // Never provisioned from a UOA team — a purely local team.
  { id: localTeamId, organizationId, externalOrgId: null, externalTeamId: null },
]

export const makePrisma = (): PrismaClient =>
  ({
    // The roster response attaches each person's local principal id, resolved
    // org-scoped. Nobody in this fixture has ever signed in locally, so the
    // lookup finds nothing and every row keeps only its UOA subject — which is
    // exactly the shape these assertions expect.
    user: {
      findMany: async () => [],
    },
    team: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; project: { organizationId: string } }
      }) => {
        const team = teams.find(
          (candidate) =>
            candidate.id === where.id
            && candidate.organizationId === where.project.organizationId,
        )
        return team
          ? {
            externalOrgId: team.externalOrgId,
            externalTeamId: team.externalTeamId,
          }
          : null
      },
    },
  }) as unknown as PrismaClient

export const actorContextFor = (
  roles: string[],
  overrides: { teamId?: string } = {},
): AuthorizedActionContext => ({
  actor: { actorType: 'user', actorId: userId, roles },
  tenant: {
    organizationId,
    projectId,
    teamId: overrides.teamId ?? teamId,
  },
  actionContext: {
    requestId: 'req-team-members',
    uoaIdentity: {
      organizationId: externalOrgId,
      subject: 'usr_ada',
      teamId: externalTeamId,
      tokenVersion: 7,
    },
  },
})

export type StubCall = {
  url: string
  method: string
  authorization?: string
  hasAccessToken: boolean
  subjectAssertion?: string
  body?: string
}

type Responder = (call: StubCall) => Response

const stubFetch = (calls: StubCall[], respond: Responder): PinnedFetch =>
  (async (url: URL, init) => {
    const headers = new Headers(init?.headers as HeadersInit)
    const call: StubCall = {
      url: url.toString(),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization') ?? undefined,
      // UOA reads a present-but-blank access token as a malformed credential,
      // so the signed-subject path keeps it absent in every form.
      hasAccessToken: headers.has('x-uoa-access-token'),
      subjectAssertion: headers.get('x-uoa-subject-assertion') ?? undefined,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    }
    calls.push(call)
    return respond(call)
  }) as PinnedFetch

export const json = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const rosterDeps = (calls: StubCall[], respond: Responder) => ({
  fetchImpl: stubFetch(calls, respond),
  // The egress is IP-pinned; stub DNS so the pinned transport still runs.
  resolveHost: async () => ['93.184.216.34'],
})

export const forbidUpstream = (message: string) => ({
  fetchImpl: (async () => {
    assert.fail(message)
  }) as unknown as PinnedFetch,
  resolveHost: async () => ['93.184.216.34'],
})

export const makeApp = async (
  actorContext: AuthorizedActionContext,
  deps: Parameters<typeof registerTeamMembersRoutes>[2],
) => {
  const app = Fastify({ logger: false })
  registerTeamMembersRoutes(
    app,
    {
      prisma: makePrisma(),
      requireActorContext: () => actorContext,
      // Fail if a UOA-bound relay regresses to the projected org-role gate.
      requireOrgAdmin: () => assert.fail('UOA authorizes exact-team mutations'),
    } as unknown as Parameters<typeof registerTeamMembersRoutes>[1],
    deps,
  )
  return app
}

export const teamRoster = {
  data: [
    {
      subject: 'usr_ada',
      identity: { displayName: 'Ada Lovelace', email: 'ada@acme.test' },
      teamRole: 'owner',
      status: 'ACTIVE',
    },
    {
      subject: 'usr_grace',
      identity: { displayName: 'Grace Hopper', email: 'grace@acme.test' },
      teamRole: 'member',
      status: 'DEACTIVATED',
    },
    // A row with no subject is not a member — it must not become one.
    { teamRole: 'member' },
  ],
  total: 2,
  meta: { hasMore: false, nextCursor: null, prevCursor: null },
  permissions: { addMember: true, viewMemberEmail: true },
}

