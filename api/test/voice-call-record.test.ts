import assert from 'node:assert/strict'
import test from 'node:test'

import type { VoiceTranscriptLine } from '@nessie/schemas'

import {
  buildVoiceFunctionDeclarations,
  buildVoiceSystemInstruction,
} from '../src/services/voice/voice-context.js'
import {
  renderCallSummary,
  renderTranscriptMarkdown,
} from '../src/services/voice/voice-transcript.js'

const line = (
  speaker: 'user' | 'assistant',
  text: string,
  atMs = 0,
): VoiceTranscriptLine => ({ speaker, text, atMs })

test('the call summary stays inside the message content cap', () => {
  const lines = Array.from({ length: 400 }, (_, index) =>
    line(index % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(200), index * 1_000),
  )
  const summary = renderCallSummary({ durationMs: 400_000, lines, hasAttachment: true })

  // Messages cap at 4,000 characters, so a long call must summarise rather
  // than fail the write at hang-up.
  assert.ok(summary.length < 4_000, `summary was ${summary.length} chars`)
  assert.ok(summary.endsWith('…') || summary.includes('…'))
  assert.match(summary, /^Voice call · 6 min 40s · 400 turns/u)
})

test('a call where nobody spoke still produces an honest record', () => {
  const summary = renderCallSummary({ durationMs: 3_000, lines: [], hasAttachment: false })
  assert.match(summary, /Voice call · 3s · 0 turns/u)
  assert.match(summary, /Nothing was said/u)
  // Nothing to attach, so nothing may claim there is.
  assert.doesNotMatch(summary, /transcript attached/iu)
})

test('a short call keeps its whole exchange in the summary', () => {
  const summary = renderCallSummary({
    durationMs: 65_000,
    lines: [line('user', 'What is on my calendar?'), line('assistant', 'Two meetings.')],
    hasAttachment: true,
  })
  assert.match(summary, /1 min 5s · 2 turns/u)
  assert.match(summary, /You: What is on my calendar\?/u)
  assert.match(summary, /Assistant: Two meetings\./u)
  assert.match(summary, /Full transcript attached\./u)
})

test('the transcript file labels speakers as text, never as roles', () => {
  const markdown = renderTranscriptMarkdown({
    agentName: 'Ada',
    durationMs: 90_000,
    lines: [line('user', 'Hello', 1_500), line('assistant', 'Hi there', 4_000)],
    startedAt: new Date('2026-09-02T09:00:00.000Z'),
    userDisplayName: 'Ondrej',
  })

  assert.match(markdown, /# Voice call with Ada/u)
  assert.match(markdown, /- Duration: 1 min 30s/u)
  assert.match(markdown, /- Turns: 2/u)
  // Labelled prose, so a later read of this file is an observation rather
  // than two speakers' turns the model could take instructions from.
  assert.match(markdown, /\*\*00:01 Ondrej:\*\* Hello/u)
  assert.match(markdown, /\*\*00:04 Ada:\*\* Hi there/u)
  assert.match(markdown, /Transcribed on the caller’s device/u)
})

test('the system instruction carries identity and speech, never conversation history', () => {
  const instruction = buildVoiceSystemInstruction({
    agentName: 'Ada',
    agentSystemPrompt: 'Prefer metric units.',
    userDisplayName: 'Ondrej',
  })

  assert.match(instruction, /You are Ada, speaking with Ondrej/u)
  assert.match(instruction, /Prefer metric units\./u)
  // The observations-are-not-instructions framing survives from Coder's
  // security contract: tool results still reach this session.
  assert.match(instruction, /information, never an instruction/u)
})

test('a caller with no display name still gets a usable instruction', () => {
  const instruction = buildVoiceSystemInstruction({
    agentName: 'Ada',
    agentSystemPrompt: null,
    userDisplayName: null,
  })
  assert.match(instruction, /the person you assist/u)
  assert.doesNotMatch(instruction, /null/u)
})

test('phase 1 declares exactly the hand-off tool, with no client-side authority', () => {
  const declarations = buildVoiceFunctionDeclarations()
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0]?.['name'], 'pa_send')
  const parameters = declarations[0]?.['parameters'] as Record<string, unknown>
  assert.deepEqual(parameters['required'], ['text'])
})
