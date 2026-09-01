import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deepWaterResearchLanguages,
  deepWaterResearchModes,
  deepWaterResearchValuesFromPreset,
  defaultDeepWaterResearchValues,
  resolveDeepWaterResearchMode,
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

test('Deep Water modes carry complete values and derive rather than store', () => {
  const ids = deepWaterResearchModes.map((mode) => mode.id)
  assert.deepEqual(ids, ['light', 'standard', 'heavy'])

  // The default form is Standard, so the dialog opens on that mode.
  assert.equal(resolveDeepWaterResearchMode(defaultDeepWaterResearchValues), 'standard')

  // Every mode's values resolve back to that mode — the selector is derived
  // from the values, never stored beside them.
  for (const mode of deepWaterResearchModes) {
    assert.equal(
      resolveDeepWaterResearchMode({ ...defaultDeepWaterResearchValues, ...mode.values }),
      mode.id,
    )
  }

  // Any deviation from a preset opens on Custom with the values intact.
  assert.equal(
    resolveDeepWaterResearchMode({ ...defaultDeepWaterResearchValues, sections: 9 }),
    'custom',
  )
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

  // A card preset that deviates from every mode opens the dialog on Custom.
  assert.equal(
    resolveDeepWaterResearchMode(deepWaterResearchValuesFromPreset(preset ?? undefined)),
    'custom',
  )
})
