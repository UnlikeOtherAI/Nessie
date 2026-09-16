// Which door the top bar offers depends on who is at it.
//
// The page can already name your teams when you are signed in, so offering
// that same person a "Sign in" button is the site contradicting itself. These
// hold the three states apart: unknown (nothing), signed out (Sign in), signed
// in (Your account). The first matters most — an anonymous visitor is almost
// all of this page's traffic, and a control that appears and then changes its
// mind is worse than one that waits.
import assert from 'node:assert/strict'
import test from 'node:test'

import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'

import { Header } from '../src/home/header'
import { accountUrl, signInUrl } from '../src/home/content'
import { LandingTeamsContext } from '../src/signed-in-teams/use-landing-teams'
import type { LandingTeamsState } from '../src/signed-in-teams/use-landing-teams'

const team = { active: true, href: 'https://general.acme.nessie.works/channels', label: 'General' }

const headerWith = (state: LandingTeamsState): string =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LandingTeamsContext.Provider value={state}>
        <Header />
      </LandingTeamsContext.Provider>
    </MemoryRouter>,
  )

test('before the read settles the top bar offers no door at all', () => {
  const html = headerWith({ settled: false, signedIn: false, teams: [] })
  assert.ok(!html.includes('Sign in'), 'a signed-in visitor must not glimpse "Sign in"')
  assert.ok(!html.includes('Your account'))
})

test('signed out, the top bar offers Sign in', () => {
  const html = headerWith({ settled: true, signedIn: false, teams: [] })
  assert.ok(html.includes('Sign in'))
  assert.ok(html.includes(signInUrl))
  assert.ok(!html.includes('Your account'))
})

test('signed in, the top bar offers the account rather than a sign-in it already has', () => {
  const html = headerWith({ settled: true, signedIn: true, teams: [team] })
  assert.ok(html.includes('Your account'))
  assert.ok(html.includes(accountUrl))
  assert.ok(!html.includes('>Sign in<'), 'the page knows who this is; it must not ask them to sign in')
})
