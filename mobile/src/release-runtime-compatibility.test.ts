import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const mobilePackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url).toString()), 'utf8'),
) as { dependencies: Record<string, string> }

const teamPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url).toString()), 'utf8'),
) as { pnpm?: { overrides?: Record<string, string> } }

const reactNativePackage = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../node_modules/react-native/package.json', import.meta.url).toString(),
    ),
    'utf8',
  ),
) as { peerDependencies: Record<string, string> }

test('the release bundle uses a React version supported by React Native', () => {
  assert.match(mobilePackage.dependencies.react, /^19\.2\.\d+$/)
  assert.equal(reactNativePackage.peerDependencies.react, '^19.2.0')
  assert.equal(teamPackage.pnpm?.overrides?.react, undefined)
})
