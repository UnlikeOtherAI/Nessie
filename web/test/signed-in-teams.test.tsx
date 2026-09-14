import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { SignedInTeams, SignedInTeamsSection } from '../src/signed-in-teams/SignedInTeams'
import { fetchLandingTeams, LANDING_TEAMS_PATH } from '../src/signed-in-teams/landing-teams'

const design = {
  label: 'Design',
  orgName: 'Acme',
  avatarImageUrl: 'https://authentication.unlikeotherai.com/teams/t1/avatar?size=128',
  active: true,
  href: 'https://design.acme.nessie.works/channels',
}
const sales = { label: 'Sales Team', active: false, href: 'https://app.nessie.works/channels' }

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('an empty list renders nothing at all', () => {
  assert.equal(renderToStaticMarkup(<SignedInTeamsSection teams={[]} />), '')
})

test('the first render, before any answer, renders nothing (no flash for anonymous visitors)', () => {
  assert.equal(renderToStaticMarkup(<SignedInTeams apiOrigin="https://api.nessie.works" />), '')
})

test('signed in, every team is listed with its organisation, avatar and link', () => {
  const html = renderToStaticMarkup(<SignedInTeamsSection teams={[design, sales]} />)
  assert.match(html, /<section[^>]*aria-labelledby="landing-teams-title"/)
  assert.match(html, />Your teams</)
  assert.match(html, /href="https:\/\/design\.acme\.nessie\.works\/channels"/)
  assert.match(html, /href="https:\/\/app\.nessie\.works\/channels"/)
  assert.match(html, />Design</)
  assert.match(html, />Acme</)
  assert.match(html, /src="https:\/\/authentication\.unlikeotherai\.com\/teams\/t1\/avatar\?size=128"/)
  // No avatar: initials stand in.
  assert.match(html, />ST</)
})

test('only the active team is marked current', () => {
  const html = renderToStaticMarkup(<SignedInTeamsSection teams={[design, sales]} />)
  assert.equal(html.match(/aria-current="true"/g)?.length, 1)
  assert.equal(html.match(/>Current</g)?.length, 1)
  assert.ok(html.indexOf('aria-current') < html.indexOf('Sales Team'))
})

test('the read carries the visitor cookie and asks the one landing path', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const teams = await fetchLandingTeams({
    apiOrigin: 'https://api.nessie.works',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse({ data: { teams: [design, sales] } })
    }) as typeof fetch,
  })
  assert.deepEqual(teams, [design, sales])
  assert.equal(calls[0]?.url, `https://api.nessie.works${LANDING_TEAMS_PATH}`)
  assert.equal(calls[0]?.init?.credentials, 'include')
  assert.equal(calls[0]?.init?.cache, 'no-store')
})

test('every failure is an empty list, so the section stays absent', async () => {
  const cases: Array<typeof fetch> = [
    (async () => jsonResponse({ error: { code: 'ORIGIN_NOT_ALLOWED' } }, 403)) as typeof fetch,
    (async () => jsonResponse({ data: { teams: 'nope' } })) as typeof fetch,
    (async () => new Response('<html>', { status: 200 })) as typeof fetch,
    (async () => { throw new TypeError('Failed to fetch') }) as typeof fetch,
    (async () => jsonResponse({ data: { teams: [] } })) as typeof fetch,
  ]
  for (const fetchImpl of cases) {
    assert.deepEqual(await fetchLandingTeams({ apiOrigin: 'https://api.nessie.works', fetchImpl }), [])
  }
})

test('entries that are not drawable or not safe links are dropped', async () => {
  const teams = await fetchLandingTeams({
    apiOrigin: 'https://api.nessie.works',
    fetchImpl: (async () => jsonResponse({
      data: {
        teams: [
          { ...sales, href: 'javascript:alert(1)' },
          { ...sales, label: '' },
          { ...sales, active: 'yes' },
          { ...design, avatarImageUrl: 'data:image/png;base64,AAAA' },
        ],
      },
    })) as typeof fetch,
  })
  const { avatarImageUrl: _dropped, ...withoutAvatar } = design
  assert.deepEqual(teams, [withoutAvatar])
})
