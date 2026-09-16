import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseTeamHandoff,
  teamHandoffSpentHref,
  withTeamHandoff,
  TEAM_HANDOFF_ORG_PARAM,
  TEAM_HANDOFF_TEAM_PARAM,
} from '../src/lib/tenant-team-handoff.js'

const landing = 'https://app.nessie.works/channels'
const target = { organizationId: 'cmu1733xo00aas60170gvuxsy', teamId: 'cmu17abc00aas60170gvuxsy' }

test('a handoff round-trips through the address bar', () => {
  const href = withTeamHandoff(landing, target)
  assert.ok(href)
  assert.deepEqual(parseTeamHandoff(href), target)
  assert.equal(teamHandoffSpentHref(href), landing)
})

test('an existing query is kept and the handoff is the only thing spent', () => {
  const href = withTeamHandoff(`${landing}?theme=dark`, target)
  assert.ok(href)
  assert.equal(teamHandoffSpentHref(href), `${landing}?theme=dark`)
})

test('anything that is not a pair of plausible ids is not a handoff', () => {
  for (const bad of [
    landing,
    `${landing}?${TEAM_HANDOFF_ORG_PARAM}=org_a`,
    `${landing}?${TEAM_HANDOFF_TEAM_PARAM}=team_a`,
    `${landing}?${TEAM_HANDOFF_ORG_PARAM}=&${TEAM_HANDOFF_TEAM_PARAM}=team_a`,
    // Shapes a switch should never be asked to carry.
    `${landing}?${TEAM_HANDOFF_ORG_PARAM}=../../etc&${TEAM_HANDOFF_TEAM_PARAM}=team_a`,
    `${landing}?${TEAM_HANDOFF_ORG_PARAM}=${'a'.repeat(65)}&${TEAM_HANDOFF_TEAM_PARAM}=team_a`,
    `${landing}?${TEAM_HANDOFF_ORG_PARAM}=a%20b&${TEAM_HANDOFF_TEAM_PARAM}=team_a`,
    'not a url',
  ]) {
    assert.equal(parseTeamHandoff(bad), null, bad)
  }
})

test('an unusable target or address produces no handoff, never a broken one', () => {
  assert.equal(withTeamHandoff(landing, null), null)
  assert.equal(withTeamHandoff(landing, { organizationId: '', teamId: 'team_a' }), null)
  assert.equal(withTeamHandoff(landing, { organizationId: 'org a', teamId: 'team_a' }), null)
  assert.equal(withTeamHandoff('not a url', target), null)
})
