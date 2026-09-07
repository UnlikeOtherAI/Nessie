import assert from 'node:assert/strict'
import test from 'node:test'

import { isCurrentLiveViewDisconnect } from '../src/components/features/browser-cloud/live-view-recovery.js'

const frame = {} as Window
const otherFrame = {} as Window
const origin = 'https://www.browserbase.com'

test('only accepts Browserbase disconnect notices from the live iframe currently on screen', () => {
  const event = (overrides: Partial<MessageEvent<unknown>>): Pick<MessageEvent<unknown>, 'data' | 'origin' | 'source'> => ({
    data: 'browserbase-disconnected', origin, source: frame, ...overrides,
  })

  assert.equal(isCurrentLiveViewDisconnect(event({}), origin, frame), true)
  assert.equal(isCurrentLiveViewDisconnect(event({ source: otherFrame }), origin, frame), false)
  assert.equal(isCurrentLiveViewDisconnect(event({ origin: 'https://attacker.example' }), origin, frame), false)
  assert.equal(isCurrentLiveViewDisconnect(event({ data: 'connected' }), origin, frame), false)
  assert.equal(isCurrentLiveViewDisconnect(event({ data: { type: 'browserbase-disconnected' } }), origin, frame), false)
})
