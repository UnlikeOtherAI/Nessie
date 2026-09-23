import assert from 'node:assert/strict'
import test from 'node:test'

import { describeMirroredSources } from '../src/run/pa-tools/provisioning-ticket-trigger.js'

// A ticket trigger on a mirrored project says, in the tool's answer, that a
// move on the connected board never starts work
// (docs/plans/2026-09-23-ticket-driven-agents/triggers.md → "Board watchers").

test('an unmirrored project says nothing about sources', () => {
  assert.equal(describeMirroredSources([], false), null)
})

test('a mirrored project names its sources and what their own changes can do', () => {
  assert.equal(
    describeMirroredSources([{ name: 'Platform', provider: 'linear' }], false),
    'This project mirrors Linear "Platform": a ticket moved there never starts work; only a person moving it '
    + 'on this board does. Its own changes wake nothing unless the trigger includes source events.',
  )
  assert.match(
    describeMirroredSources([{ name: 'Web', provider: 'jira' }, { name: 'API', provider: 'github' }], true) ?? '',
    /mirrors Jira "Web", GitHub "API": .+ Its own changes wake live work, and reach the agent marked untrusted\.$/,
  )
})
