import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  resolveTeamSwitchDestination,
  teamSwitchDestination,
  tenantReturnDestination,
} from '../src/lib/tenant-navigation.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const teamUrl = 'https://general.nessie-works.nessie.works'
const canonicalOrigin = 'https://app.nessie.works'
const portalHost = 'nessie-works.nessie.works'

test('a browser follows the switch to the team host', () => {
  assert.deepEqual(
    teamSwitchDestination({
      canonicalOrigin: null,
      currentHost: 'app.nessie.works',
      currentHostServesApp: true,
      inNativeShell: false,
      teamUrl,
    }),
    { kind: 'document', href: `${teamUrl}/channels` },
  )
})

test('a native shell stays on its origin and navigates in-app', () => {
  assert.deepEqual(
    teamSwitchDestination({
      canonicalOrigin: null,
      currentHost: 'app.nessie.works',
      currentHostServesApp: true,
      inNativeShell: true,
      teamUrl,
    }),
    { kind: 'in-app', path: '/channels' },
  )
})

test('the same host, no address, or a malformed address navigates in-app', () => {
  for (const [currentHost, url] of [
    ['general.nessie-works.nessie.works', teamUrl],
    ['app.nessie.works', null],
    ['app.nessie.works', 'not a url'],
  ] as const) {
    assert.deepEqual(
      teamSwitchDestination({
        canonicalOrigin: null,
        currentHost,
        currentHostServesApp: true,
        inNativeShell: false,
        teamUrl: url,
      }),
      { kind: 'in-app', path: '/channels' },
    )
  }
})

test('an organisation portal never navigates in-app, which would reload the portal', () => {
  const portal = { canonicalOrigin, currentHost: portalHost, currentHostServesApp: false }
  // Browser with an address: the team host.
  assert.deepEqual(teamSwitchDestination({ ...portal, inNativeShell: false, teamUrl }), {
    kind: 'document',
    href: `${teamUrl}/channels`,
  })
  // No address, or a native shell: the canonical origin.
  for (const facts of [
    { inNativeShell: false, teamUrl: null },
    { inNativeShell: true, teamUrl },
  ]) {
    assert.deepEqual(teamSwitchDestination({ ...portal, ...facts }), {
      kind: 'document',
      href: `${canonicalOrigin}/channels`,
    })
  }
  // Nothing known at all: stay, rather than a same-host reload.
  assert.deepEqual(
    teamSwitchDestination({ ...portal, canonicalOrigin: null, inNativeShell: false, teamUrl: null }),
    { kind: 'none' },
  )
})

test('a native shell does not look up the team address', async () => {
  let asked = 0
  const fetchTeamUrl = async () => {
    asked += 1
    return teamUrl
  }
  const facts = { canonicalOrigin: null, currentHost: 'app.nessie.works', currentHostServesApp: true }

  assert.deepEqual(await resolveTeamSwitchDestination({ ...facts, fetchTeamUrl, inNativeShell: true }), {
    kind: 'in-app',
    path: '/channels',
  })
  assert.equal(asked, 0)

  assert.deepEqual(await resolveTeamSwitchDestination({ ...facts, fetchTeamUrl, inNativeShell: false }), {
    kind: 'document',
    href: `${teamUrl}/channels`,
  })
  assert.equal(asked, 1)
})

test('a stored tenant return is followed in a browser and dropped in a native shell', () => {
  const target = `${teamUrl}/channels/abc`
  assert.equal(tenantReturnDestination({ inNativeShell: false, target }), target)
  assert.equal(tenantReturnDestination({ inNativeShell: true, target }), null)
  assert.equal(tenantReturnDestination({ inNativeShell: false, target: null }), null)
})

// The components must route through the shared decision. Each test below fails
// if its entry point goes back to navigating on its own.
const assertUsesTeamSwitchDestination = (source: string) => {
  assert.match(source, /resolveTeamSwitchDestination\(\{/)
  assert.match(source, /inNativeShell: isNativeShell\(\)/)
  assert.match(source, /window\.location\.assign\(destination\.href\)/)
  // The guarded navigation is the only document navigation.
  assert.equal(source.match(/window\.location\.assign\(/g)?.length, 1)
}

test('TeamSwitcher navigates through the shared policy', () => {
  const switcher = readSource('../src/layouts/admin-shell/TeamSwitcher.tsx')
  assertUsesTeamSwitchDestination(switcher)
  assert.match(switcher, /currentHostServesApp: true/)
})

test('OrgPortal leaves the portal host through the shared policy', () => {
  const portal = readSource('../src/layouts/tenant/OrgPortal.tsx')
  assertUsesTeamSwitchDestination(portal)
  assert.match(portal, /currentHostServesApp: false/)
  assert.match(portal, /canonicalOrigin: signInOrigin/)
})

test('TenantReturnHandoff never follows a tenant return in a native shell', () => {
  const handoff = readSource('../src/layouts/tenant/TenantReturnHandoff.tsx')
  assert.match(handoff, /tenantReturnDestination\(\{\s*inNativeShell: isNativeShell\(\)/)
  assert.match(handoff, /if \(target\) window\.location\.assign\(target\)/)
  assert.equal(handoff.match(/window\.location\.assign\(/g)?.length, 1)
})
