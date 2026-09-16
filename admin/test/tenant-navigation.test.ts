import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  nativeShellRecoveryHref,
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
      currentHostIsTenant: false,
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
      currentHostIsTenant: false,
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
        currentHostIsTenant: false,
        currentHostServesApp: true,
        inNativeShell: false,
        teamUrl: url,
      }),
      { kind: 'in-app', path: '/channels' },
    )
  }
})

test('an organisation portal never navigates in-app, which would reload the portal', () => {
  const portal = {
    canonicalOrigin,
    currentHost: portalHost,
    currentHostIsTenant: true,
    currentHostServesApp: false,
  }
  // Browser with an address: the team host.
  assert.deepEqual(teamSwitchDestination({ ...portal, inNativeShell: false, teamUrl }), {
    kind: 'document',
    href: `${teamUrl}/channels`,
  })
  // No address, or a native shell: the canonical origin, carrying the team.
  for (const facts of [
    { inNativeShell: false, teamUrl: null },
    { inNativeShell: true, teamUrl },
  ]) {
    assert.deepEqual(teamSwitchDestination({ ...portal, ...facts }), {
      kind: 'document',
      href: `${canonicalOrigin}/channels`,
    })
  }
  // With no target to carry it is still the canonical origin, not a stay.
  assert.deepEqual(
    teamSwitchDestination({ ...portal, inNativeShell: false, targetTeam: null, teamUrl: null }),
    { kind: 'document', href: `${canonicalOrigin}/channels` },
  )
  // Nothing known at all: stay, rather than a same-host reload.
  assert.deepEqual(
    teamSwitchDestination({
      ...portal,
      canonicalOrigin: null,
      inNativeShell: false,
      teamUrl: null,
    }),
    { kind: 'none' },
  )
})

test('a native shell does not look up the team address', async () => {
  let asked = 0
  const fetchTeamUrl = async () => {
    asked += 1
    return teamUrl
  }
  const facts = {
    canonicalOrigin: null,
    currentHost: 'app.nessie.works',
    currentHostIsTenant: false,
    currentHostServesApp: true,
  }

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

test('a native shell on a tenant host goes back to the canonical origin', () => {
  const shell = { canonicalOrigin, inNativeShell: true }
  assert.equal(
    nativeShellRecoveryHref({ ...shell, currentUrl: `${teamUrl}/channels/abc?x=1#m`, hostKind: 'team' }),
    `${canonicalOrigin}/channels/abc?x=1#m`,
  )
  assert.equal(
    nativeShellRecoveryHref({ ...shell, currentUrl: `https://${portalHost}/anything`, hostKind: 'organisation' }),
    `${canonicalOrigin}/channels`,
  )
})

test('recovery leaves browsers, ordinary hosts and the canonical origin alone', () => {
  const facts = { canonicalOrigin, currentUrl: `${teamUrl}/channels`, hostKind: 'team' as const }
  assert.equal(nativeShellRecoveryHref({ ...facts, inNativeShell: false }), null)
  assert.equal(nativeShellRecoveryHref({ ...facts, hostKind: null, inNativeShell: true }), null)
  assert.equal(nativeShellRecoveryHref({ ...facts, canonicalOrigin: null, inNativeShell: true }), null)
  assert.equal(
    nativeShellRecoveryHref({ ...facts, currentUrl: `${canonicalOrigin}/channels`, inNativeShell: true }),
    null,
  )
})

test('TenantHostGate sends a native shell off a tenant host through the shared policy', () => {
  const gate = readSource('../src/layouts/tenant/TenantHostGate.tsx')
  assert.match(gate, /nativeShellRecoveryHref\(\{/)
  assert.match(gate, /inNativeShell: isNativeShell\(\)/)
  assert.match(gate, /if \(recoveryHref\) window\.location\.replace\(recoveryHref\)/)
  assert.match(gate, /if \(recoveryHref \|\| !token/)
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

test('every in-app switch lands through the one hook', () => {
  const hook = readSource('../src/facades/team/navigation.ts')
  assertUsesTeamSwitchDestination(hook)
  assert.match(hook, /currentHostServesApp: true/)
  assert.match(hook, /currentHostIsTenant: Boolean\(tenantHost\?\.kind\)/)

  // Accepting an invitation and creating a team used to navigate in-app and
  // stay on whatever tenant host they were on, which is the same defect the
  // rail picker had. All three now land the same way.
  for (const path of [
    '../src/facades/team/invitations.ts',
    '../src/facades/team/provisioning.ts',
  ]) {
    const source = readSource(path)
    assert.match(source, /useTeamSwitchNavigation\(\)/, path)
    assert.doesNotMatch(source, /navigate\('\/channels'/, path)
  }

  // The switcher keeps a router navigation for local sessions, which have no
  // tenant address and cannot be on a tenant host. Both of its UOA arrivals —
  // the ordinary switch and the one recovery that finds the switch already
  // landed — go through the hook.
  const switcher = readSource('../src/layouts/admin-shell/TeamSwitcher.tsx')
  assert.match(switcher, /useTeamSwitchNavigation\(\)/)
  assert.equal(switcher.match(/await landInTeam\(team\.teamId\)/g)?.length, 2)
})

test('OrgPortal leaves the portal host through the shared policy', () => {
  const portal = readSource('../src/layouts/tenant/OrgPortal.tsx')
  assertUsesTeamSwitchDestination(portal)
  assert.match(portal, /currentHostServesApp: false/)
  assert.match(portal, /canonicalOrigin: signInOrigin/)
  assert.match(portal, /currentHostIsTenant: true/)
})

test('TenantReturnHandoff never follows a tenant return in a native shell', () => {
  const handoff = readSource('../src/layouts/tenant/TenantReturnHandoff.tsx')
  assert.match(handoff, /tenantReturnDestination\(\{\s*inNativeShell: isNativeShell\(\)/)
  assert.match(handoff, /if \(target\) window\.location\.assign\(target\)/)
  assert.equal(handoff.match(/window\.location\.assign\(/g)?.length, 1)
})

/**
 * The defect this section pins, in the words of the person who hit it: "I just
 * switched from KiloMayo to UnlikeOtherAI, and I'm still on the KiloMayo URL."
 *
 * A team host serves the app, so a switch to a team with no address of its own
 * used to route in-app and stay put — leaving `general.kilomayo.nessie.works`
 * displaying a different organisation's channels, and the next load of that
 * address switching the session back. Teams with no address are not exotic:
 * `/api/hosts/address` is a `/domain/*` read scoped to this deployment's UOA
 * client domain, so every organisation founded on another product's domain has
 * one, and its hostname has no certificate to land on either.
 */
test('a team host never keeps a team that is not its own', () => {
  const onTeamHost = {
    canonicalOrigin,
    currentHost: 'general.kilomayo.nessie.works',
    currentHostIsTenant: true,
    currentHostServesApp: true,
    inNativeShell: false,
  }
  // No address for the team being switched to: leave for the canonical origin,
  // which serves every team — including the ones with no address of their own.
  assert.deepEqual(
    teamSwitchDestination({ ...onTeamHost, teamUrl: null }),
    { kind: 'document', href: `${canonicalOrigin}/channels` },
  )
  // Another team's address: follow it, unchanged.
  assert.deepEqual(
    teamSwitchDestination({ ...onTeamHost, teamUrl }),
    { kind: 'document', href: `${teamUrl}/channels` },
  )
  // This host IS the team's address: the URL is already right, so route.
  assert.deepEqual(
    teamSwitchDestination({ ...onTeamHost, teamUrl: 'https://general.kilomayo.nessie.works' }),
    { kind: 'in-app', path: '/channels' },
  )
  // Nowhere to go: the app still opens rather than blanking the screen.
  assert.deepEqual(
    teamSwitchDestination({ ...onTeamHost, canonicalOrigin: null, teamUrl: null }),
    { kind: 'in-app', path: '/channels' },
  )
})

test('the canonical origin stays put when a team has no address', () => {
  assert.deepEqual(
    teamSwitchDestination({
      canonicalOrigin,
      currentHost: 'app.nessie.works',
      currentHostIsTenant: false,
      currentHostServesApp: true,
      inNativeShell: false,
      teamUrl: null,
    }),
    { kind: 'in-app', path: '/channels' },
  )
})

/**
 * WHEN the app may mount on a team address is enumerated in
 * `tenant-host-render.test.ts`. This pins only that the gate still reports the
 * switch's outcome into that decision instead of swallowing it, which is how
 * the failure became invisible in the first place.
 */
test('a team host reports the outcome of its switch', () => {
  const gate = readSource('../src/layouts/tenant/TenantHostGate.tsx')
  assert.match(gate, /setSwitchState\('switching'\)/)
  assert.match(gate, /setSwitchState\('failed'\)/)
  assert.match(gate, /tenantHostRender\(\{[\s\S]*?switchState,/)
  assert.doesNotMatch(gate, /\.catch\(\(\) => undefined\)/)
})
