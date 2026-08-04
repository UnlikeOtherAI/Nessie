import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deepWaterResearchLanguages,
  deepWaterResearchPresets,
  defaultDeepWaterResearchValues,
} from '../src/components/features/integrations/deep-water-research-options.js'
import {
  deepWaterResearchLauncherNavigationState,
  readDeepWaterResearchLauncherPreset,
} from '../src/facades/integrations/deep-water-research-launcher-navigation.js'

test('Deep Water offers a complete unique ISO language selector', () => {
  const codes = deepWaterResearchLanguages.map((language) => language.code)

  assert.equal(new Set(codes).size, codes.length)
  assert.ok(codes.length >= 180)
  assert.ok(codes.includes('en'))
  assert.ok(codes.includes('cy'))
  assert.ok(codes.includes('zh'))
})

test('Deep Water templates configure the launcher without replacing its prompt', () => {
  const balanced = deepWaterResearchPresets.find((preset) => preset.id === 'balanced-research')

  assert.equal(balanced?.values.depth, 'standard')
  assert.equal(balanced?.values.sections, 8)
  assert.equal('query' in (balanced?.values ?? {}), false)
  assert.equal(defaultDeepWaterResearchValues.outputLanguage, 'en')
})

test('chat launcher navigation accepts only a bounded research preset', () => {
  const preset = readDeepWaterResearchLauncherPreset(
    deepWaterResearchLauncherNavigationState({
      outputLanguage: 'ja',
      query: 'Map the supply chain for battery-grade graphite.',
      sections: 9,
    }),
  )

  assert.equal(preset?.outputLanguage, 'ja')
  assert.equal(preset?.sections, 9)
  assert.equal(readDeepWaterResearchLauncherPreset({ deepWaterResearchLauncher: { preset: {
    sections: 100,
  } } }), null)
})
