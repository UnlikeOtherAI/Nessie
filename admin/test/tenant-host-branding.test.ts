import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as React from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// The production Vite transform injects the JSX runtime. Node's lightweight
// tsx loader uses the classic transform for imported TSX modules.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

// The tenant frame prints the address the visitor typed, which it reads off
// `window`. There is no DOM here, so give it just that.
;(globalThis as typeof globalThis & { window: unknown }).window = {
  location: { hostname: 'design.acme.nessie.works', href: 'https://design.acme.nessie.works/' },
}

const { TeamHostSignIn } = await import('../src/layouts/tenant/TeamHostSignIn.js')

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const ORGANISATION = {
  externalOrgId: 'org_1',
  iconUrl: null,
  name: 'Acme Industries',
  slug: 'acme',
}

test("a team address signed out shows the tenant's brand and a way in", () => {
  const html = renderToStaticMarkup(
    createElement(TeamHostSignIn, { organisation: ORGANISATION, signInOrigin: 'https://app.nessie.works' }),
  )

  assert.match(html, /Acme Industries/)
  assert.match(html, /design\.acme\.nessie\.works/)
  assert.match(html, /Sign in/)
  // Fallback mark when the organisation has no icon: its initials, not the
  // product's own logo.
  assert.match(html, /AI/)
})

test('it never names the team behind the address', () => {
  const source = readSource('../src/layouts/tenant/TeamHostSignIn.tsx')
  // The component takes no team at all, so no future edit can render one
  // without also widening its props — which is the point.
  assert.doesNotMatch(source, /teamName|team\.name|useTenantTeam/)
})

test('the gate shows it only once the session has settled as signed out', () => {
  const source = readSource('../src/layouts/tenant/TenantHostGate.tsx')

  assert.match(
    source,
    /data\?\.kind === 'team' && sessionState === 'unauthenticated'/,
    'a team host must not fall through to the product marketing page when signed out',
  )
  // 'loading' would flash the card at somebody who is signed in; 'bootstrap'
  // owns the screen during first-run setup.
  assert.doesNotMatch(source, /sessionState !== 'authenticated'/)
})

test('the organisation portal and a team address share one brand frame', () => {
  const portal = readSource('../src/layouts/tenant/OrgPortal.tsx')
  const teamHost = readSource('../src/layouts/tenant/TeamHostSignIn.tsx')

  for (const source of [portal, teamHost]) {
    assert.match(source, /TenantBrandFrame/)
  }
  // The portal must not carry its own copy of the mark or the sign-in handoff.
  assert.doesNotMatch(portal, /const OrgMark|window\.location\.href =/)
})

const { parseTenantReturn } = await import('../src/lib/tenant-return.js')

test('a return address is accepted only in the shape one of ours can take', () => {
  const here = 'https://app.nessie.works'

  assert.equal(
    parseTenantReturn('https://design.acme.nessie.works/', here)?.hostname,
    'design.acme.nessie.works',
  )
  // Downgrading the connection a fresh session lands on.
  assert.equal(parseTenantReturn('http://design.acme.nessie.works/', here), null)
  // Credentials in a redirect are never something this product produces.
  assert.equal(parseTenantReturn('https://user:pw@acme.nessie.works/', here), null)
  // Already here: at best a wasted navigation, at worst a loop.
  assert.equal(parseTenantReturn('https://app.nessie.works/channels', here), null)
  assert.equal(parseTenantReturn('/channels', here), null)
  assert.equal(parseTenantReturn(null, here), null)
  assert.equal(parseTenantReturn('javascript:alert(1)', here), null)
})

test('the shape check is not the only gate — the host must really be a tenant', () => {
  const source = readSource('../src/layouts/tenant/TenantReturnHandoff.tsx')

  // An attacker-supplied host passes the shape check as easily as a real one;
  // what it cannot pass is resolution against this deployment.
  assert.match(source, /\/api\/hosts\/resolve\?host=/)
  assert.match(source, /if \(abandoned \|\| !answer\?\.kind\) return/)
  // Storing must happen only inside that answer, never straight from the URL.
  const stored = source.indexOf('rememberTenantReturn(candidate.href)')
  const resolved = source.indexOf('/api/hosts/resolve')
  assert.ok(resolved !== -1 && stored > resolved, 'the return is stored before it is vouched for')
})

test('the handoff sits above the router so every sign-in path is under it', () => {
  const source = readSource('../src/providers/AppProvider.tsx')
  assert.match(source, /<TenantReturnHandoff \/>/)
  // Above the router means it cannot write the address bar: the router owns
  // that, and a bare replaceState leaves the ledger holding a location it
  // never saw. The parameter is left where it is instead.
  assert.doesNotMatch(
    readSource('../src/layouts/tenant/TenantReturnHandoff.tsx'),
    /history\.(?:replaceState|pushState)\(/,
  )
  // Sign-in finishes on more than one screen — /login, /login/completing, and
  // a desktop or mobile session import — so it must not live on any of them.
  assert.doesNotMatch(readSource('../src/pages/LoginPage.tsx'), /TenantReturnHandoff/)
})

test('a kept address is consumed once', () => {
  const source = readSource('../src/layouts/tenant/TenantReturnHandoff.tsx')
  const forgot = source.indexOf('forgetTenantReturn()')
  const went = source.indexOf('window.location.assign(target)')
  assert.ok(forgot !== -1 && went !== -1 && forgot < went, 'clear before navigating, not after')
})
