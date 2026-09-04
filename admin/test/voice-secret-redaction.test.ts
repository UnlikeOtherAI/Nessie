import assert from 'node:assert/strict'
import test from 'node:test'

import { collectTranscript } from '../src/facades/voice/voice-transcript-collector.js'

test('live and finalized voice transcripts expose only protected replacements', () => {
  const collector = collectTranscript(1_000)
  const secret = `sk-proj-${'aB3_'.repeat(8)}`

  collector.appendUser(`My key is ${secret}`)
  collector.appendAssistant(`I will not repeat ${secret}`)

  assert.equal(collector.liveUserText().includes(secret), false)
  assert.equal(collector.liveAssistantText().includes(secret), false)
  collector.finalise(2_000)
  assert.equal(JSON.stringify(collector.lines()).includes(secret), false)
  assert.match(collector.lines()[0]?.text ?? '', /\[REDACTED_SECRET\]/u)
})
