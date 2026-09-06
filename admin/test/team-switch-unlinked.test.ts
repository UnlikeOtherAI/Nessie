import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { teamSwitchFailureMessage } from '../src/layouts/admin-shell/team-switch-message.js'

const readSource = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const message = (code: string): string =>
  teamSwitchFailureMessage({ code, currentTeam: 'Alpha', targetTeam: 'Beta' })

test('a team with no UnlikeOtherAI identity says so, and does not promise sign-in', () => {
  const text = message('TEAM_NOT_UOA_LINKED')

  assert.match(text, /not linked to UnlikeOtherAI/)
  assert.match(text, /cannot be opened/)
  // The whole point: signing in again returns the person to this same message,
  // because there is nothing on the other side to authenticate them into.
  assert.match(text, /signing in again will not help/i)
})

test('a team that is in UnlikeOtherAI but needs fresh proof says to sign in', () => {
  const text = message('SSO_TEAM_REAUTH_REQUIRED')

  assert.match(text, /Sign in with UnlikeOtherAI/)
  assert.doesNotMatch(text, /not linked/)
})

test('the two refusals are not the same sentence', () => {
  // They shared one code and one message before, so a person hitting the
  // unfixable one was told to retry the fixable one's remedy.
  assert.notEqual(message('TEAM_NOT_UOA_LINKED'), message('SSO_TEAM_REAUTH_REQUIRED'))
  // And neither is the bare fallback, which named no reason at all — that
  // fallback is exactly what shipped, and what the screenshot showed.
  const bare = teamSwitchFailureMessage({ currentTeam: 'Alpha', targetTeam: 'Beta' })
  assert.notEqual(message('TEAM_NOT_UOA_LINKED'), bare)
  assert.notEqual(message('SSO_TEAM_REAUTH_REQUIRED'), bare)
})

test('the server refuses an unlinked team before it considers re-authentication', () => {
  const source = readSource('../../api/src/services/actor-context-switch.ts')

  // Order matters: a null externalTeamId would otherwise fall into the
  // credential-mismatch branch and be reported as a sign-in problem.
  const unlinked = source.indexOf("'TEAM_NOT_UOA_LINKED'")
  const reauth = source.indexOf("'SSO_TEAM_REAUTH_REQUIRED'", source.indexOf('providerType === \'uoa\''))
  assert.ok(unlinked !== -1 && reauth !== -1 && unlinked < reauth)
  assert.match(source, /!team\.externalOrgId \|\| !team\.externalTeamId/)
  // It must stay a refusal. Minting a local session for a team UOA does not
  // know is the parallel identity path UOA ownership exists to prevent.
  assert.doesNotMatch(source, /TEAM_NOT_UOA_LINKED[\s\S]{0,200}buildSessionForUser/)
})
