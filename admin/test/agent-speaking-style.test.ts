import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AGENT_SPEAKING_STYLE_MAX_CHARS,
  AGENT_SPEAKING_STYLE_PRESETS,
  GEMINI_LIVE_VOICES,
} from '@nessie/schemas'

import {
  CUSTOM_STYLE_VALUE,
  presetForText,
  presetTextById,
} from '../src/components/features/agents/designer/speaking-style.js'

test('a preset’s own wording reads back as that preset', () => {
  for (const preset of AGENT_SPEAKING_STYLE_PRESETS) {
    assert.equal(presetForText(preset.text), preset.id)
  }
})

test('an edited field reads as custom, so nothing offers to overwrite it', () => {
  const edited = `${AGENT_SPEAKING_STYLE_PRESETS[0].text} Also call me Ondra.`
  assert.equal(presetForText(edited), CUSTOM_STYLE_VALUE)
})

test('an empty field is custom rather than a preset', () => {
  assert.equal(presetForText(''), CUSTOM_STYLE_VALUE)
  assert.equal(presetForText('   '), CUSTOM_STYLE_VALUE)
})

test('selecting "custom" seeds nothing — it describes text that already exists', () => {
  assert.equal(presetTextById(CUSTOM_STYLE_VALUE), null)
  assert.equal(presetTextById('not-a-preset'), null)
  assert.equal(
    presetTextById(AGENT_SPEAKING_STYLE_PRESETS[0].id),
    AGENT_SPEAKING_STYLE_PRESETS[0].text,
  )
})

test('every preset fits the stored column and every id is distinct', () => {
  const ids = AGENT_SPEAKING_STYLE_PRESETS.map((preset) => preset.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const preset of AGENT_SPEAKING_STYLE_PRESETS) {
    assert.ok(
      preset.text.length <= AGENT_SPEAKING_STYLE_MAX_CHARS,
      `${preset.id} is ${preset.text.length} chars`,
    )
    // A preset that did not survive `presetForText`'s trim would show as
    // "Custom" the instant it was selected.
    assert.equal(preset.text.trim(), preset.text)
  }
})

test('the curated voice list has no duplicates and every entry is described', () => {
  const names = GEMINI_LIVE_VOICES.map((voice) => voice.name)
  assert.equal(new Set(names).size, names.length)
  for (const voice of GEMINI_LIVE_VOICES) {
    assert.ok(voice.description.length > 0, `${voice.name} has no description`)
  }
})
