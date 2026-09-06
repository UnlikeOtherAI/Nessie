import assert from 'node:assert/strict'
import test from 'node:test'

import { SourceAuthError, SourceHttpError, SourceRejectedError } from '@nessie/board-sources'

import {
  buildWebhookCreateInput,
  isWebhookRegistrationRefused,
} from '../src/adapter.js'

/**
 * The deployment registers its own callback rather than depending on a webhook
 * configured once on an OAuth app — which no install gets for free, and an
 * install connecting with a pasted API key cannot get at all. These pin the two
 * decisions that path turns on, both of which are invisible until a live
 * workspace is on the other end.
 */

test('the registration asks for this team’s issues at this URL', () => {
  const input = buildWebhookCreateInput(
    { teamId: 'team-uuid', teamKey: 'KM' },
    { url: 'https://nessie.example/api/board-sources/webhooks/linear/tok' },
  )
  assert.equal(input.url, 'https://nessie.example/api/board-sources/webhooks/linear/tok')
  assert.equal(input.teamId, 'team-uuid')
  assert.equal(input.enabled, true)
  // Issues only. Every other resource type is a delivery the processor would
  // re-read an issue for and apply nothing from — comments stay out of the
  // mirror deliberately, because an upstream comment can have a narrower
  // audience than the issue it hangs on.
  assert.deepEqual(input.resourceTypes, ['Issue'])
})

test('a webhook is scoped to the container, never to the whole workspace', () => {
  const input = buildWebhookCreateInput({ teamId: 'team-uuid' }, { url: 'https://x/y' })
  // `allPublicTeams` would mirror teams nobody attached; its absence is the
  // guarantee that a source only ever hears about its own container.
  assert.equal('allPublicTeams' in input, false)
})

test('Linear saying no leaves the poll running rather than raising a fault', () => {
  // Only a workspace admin may manage webhooks, so an ordinary member's key
  // being refused is the common case. Linear reports it inside a 200, which
  // `linearGraphQl` raises as SourceHttpError; a 401/403 arrives as
  // SourceAuthError. Neither means the board is broken.
  assert.equal(isWebhookRegistrationRefused(new SourceHttpError(200, 'Admin required')), true)
  assert.equal(isWebhookRegistrationRefused(new SourceHttpError(400, 'not authorized')), true)
  assert.equal(isWebhookRegistrationRefused(new SourceAuthError()), true)
})

test('a fault on the way there is not mistaken for a refusal', () => {
  // These must propagate: the sync turns them into WEBHOOK_REGISTRATION_FAILED,
  // which is a real thing to fix. Swallowing them would hide it forever.
  assert.equal(isWebhookRegistrationRefused(new Error('socket hang up')), false)
  assert.equal(isWebhookRegistrationRefused(new SourceRejectedError('X', 'y')), false)
  assert.equal(isWebhookRegistrationRefused(undefined), false)
})
