import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchUoaTeamDirectory } from '../src/services/uoa-team-directory.js'

const SETTINGS = {
  baseUrl: 'https://authentication.example.test',
  clientSecret: 'test-secret',
  domain: 'api.example.test',
} as never

const deps = (body: unknown, status = 200) => ({
  fetchImpl: (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as never,
  // safeFetch pins to resolved addresses before dialling; a public one keeps
  // the SSRF guard happy without a live host.
  resolveHost: (async () => ['93.184.216.34']) as never,
})

const call = (body: unknown, status = 200) =>
  fetchUoaTeamDirectory(SETTINGS, 'https://api.example.test/config', 'access-token', deps(body, status))

/**
 * A `/org/me` answer shaped the way UOA actually sends it: the organisation
 * block carries BOTH the legacy `teams` (an array of id strings from the JWT
 * `org` claim) and `team_directory` (the objects the picker is built from).
 */
const ORG_ME_BODY = {
  ok: true,
  org: {
    org_id: 'uoa-org-1',
    org_role: 'owner',
    teams: ['uoa-team-1', 'uoa-team-2'],
    team_roles: { 'uoa-team-1': 'owner' },
    team_directory: [
      {
        teamId: 'uoa-team-1',
        orgId: 'uoa-org-1',
        name: 'General',
        slug: 'general',
        orgName: 'Nessie Works',
        orgSlug: 'nessie-works',
        avatarImageUrl: 'https://authentication.example.test/teams/uoa-team-1/avatar',
        role: 'owner',
      },
      {
        teamId: 'uoa-team-2',
        orgId: 'uoa-org-2',
        name: 'Design',
        slug: 'design',
        orgName: 'KiloMayo',
        orgSlug: 'kilomayo',
        role: 'member',
      },
    ],
    pending_invites: [
      { inviteId: 'inv-1', orgId: 'uoa-org-3', teamId: 'uoa-team-9', teamName: 'Ops' },
    ],
  },
}

test('the directory is read from team_directory, across organisations', async () => {
  const directory = await call(ORG_ME_BODY)

  assert.ok(directory)
  assert.deepEqual(
    directory.entries.map((entry) => [entry.organizationId, entry.teamId, entry.label]),
    [
      ['uoa-org-1', 'uoa-team-1', 'General'],
      ['uoa-org-2', 'uoa-team-2', 'Design'],
    ],
  )
  assert.equal(directory.entries[0]?.orgName, 'Nessie Works')
  assert.equal(directory.entries[1]?.orgName, 'KiloMayo')
})

test('the legacy `teams` array is ids, and reading it yields nothing', async () => {
  // This is the bug this file exists for. `org.teams` is `string[]`; every
  // element fails the object check, so the directory came back EMPTY for
  // everyone, and the product silently showed a locally derived team list
  // instead of UnlikeOtherAI's. It never threw and never logged.
  const legacyOnly = {
    ok: true,
    org: { org_id: 'uoa-org-1', teams: ['uoa-team-1', 'uoa-team-2'] },
  }
  const directory = await call(legacyOnly)

  assert.ok(directory)
  assert.deepEqual(directory.entries, [])
})

test('pending invites still come from the organisation block', async () => {
  const directory = await call(ORG_ME_BODY)

  assert.deepEqual(
    directory?.pendingInvites?.map((invite) => [invite.inviteId, invite.teamName]),
    [['inv-1', 'Ops']],
  )
})

test('no organisation context is undefined, not an empty directory', async () => {
  // UOA answers `{ok: true}` with no `org` when it cannot resolve a context for
  // this token on this domain. That is not "you have no teams": an empty
  // directory would be cached and would suppress the local fallback for the
  // whole TTL, which is how a person ends up staring at the wrong team list.
  assert.equal(await call({ ok: true }), undefined)
})

test('a non-2xx answer is undefined too', async () => {
  assert.equal(await call({ ok: false }, 500), undefined)
})

test('entries missing an id or a name are dropped, not half-rendered', async () => {
  const directory = await call({
    ok: true,
    org: {
      org_id: 'uoa-org-1',
      team_directory: [
        { teamId: 'uoa-team-1', orgId: 'uoa-org-1', name: 'Good' },
        { teamId: '', orgId: 'uoa-org-1', name: 'No id' },
        { teamId: 'uoa-team-3', orgId: 'uoa-org-1' },
      ],
    },
  })

  assert.deepEqual(directory?.entries.map((entry) => entry.label), ['Good'])
})
