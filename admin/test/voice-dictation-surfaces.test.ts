import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (relative: string) => readFileSync(path.join(here, '..', 'src', relative), 'utf8')

test('every chat composition surface uses the one dictation control', () => {
  const sharedComposer = source('components/features/channels/ChannelComposer.tsx')
  assert.match(sharedComposer, /VoiceDictationControl/u)
  assert.match(sharedComposer, /mentionRef\.current\?\.insertDictationText/u)
  // The shared composer also holds Enter while a staged file uploads.
  assert.match(sharedComposer, /submitDisabled=\{voiceDictationBlocksSubmit\(voiceState\) \|\|/u)

  // The New message page writes in the one composer, so it dictates through
  // that composer's control rather than a copy of it.
  const newMessage = source('pages/ChannelConversationComposePage.tsx')
  assert.match(newMessage, /<ChannelComposer/u)
  assert.doesNotMatch(newMessage, /VoiceDictationControl/u)

  const designer = source('components/features/agents/designer/DesignerChat.tsx')
  assert.match(designer, /VoiceDictationControl/u)
  assert.match(designer, /setSelectionRange/u)
  assert.match(designer, /voiceDictationBlocksSubmit\(voiceState\)/u)
})

test('dictation is fixed-format, bounded, cancellable and never auto-sends', () => {
  const control = source('components/features/channels/VoiceDictationControl.tsx')
  assert.match(control, /VOICE_DICTATION_MAX_RECORDING_MS/u)
  assert.match(control, /startVoiceCapture/u)
  assert.match(control, /audioBase64: encodePcmFrame\(pcm\)/u)
  assert.match(control, /\/api\/voice\/transcriptions/u)
  assert.match(control, /event\.key === 'Escape'/u)
  assert.match(control, /transcriptionAbort\.current\?\.abort\(\)/u)
  assert.match(control, /transcriptionGeneration\.current !== generation/u)
  assert.match(control, /appendBoundedVoiceFrame/u)
  assert.doesNotMatch(control, /onSubmit|onSend/u)
})
