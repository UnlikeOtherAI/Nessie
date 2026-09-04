import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DIRECT_ANDROID_UPDATE_REMIND_AFTER_MS,
  findDirectAndroidUpdate,
  parseDirectAndroidUpdatePreference,
  remindAboutDirectAndroidUpdateLater,
  skipDirectAndroidUpdate,
} from './direct-android-updater'

const manifestUrl = 'https://github.com/UnlikeOtherAI/Nessie/releases/latest/download/latest.json'
const directApkUrl = 'https://github.com/UnlikeOtherAI/Nessie/releases/download/v0.0.2/Nessie-Android.apk'

const releaseResponse = (manifest: unknown) => async () => ({
  json: async () => manifest,
  ok: true,
})

test('offers only a newer direct APK from the official release assets', async () => {
  const update = await findDirectAndroidUpdate({
    channel: 'direct',
    currentVersionCode: 4,
    fetchRelease: releaseResponse({ android: { url: directApkUrl, version: '0.1.3', versionCode: 5 } }),
    manifestUrl,
    now: 100,
    preference: {},
  })

  assert.deepEqual(update, { url: directApkUrl, version: '0.1.3', versionCode: 5 })
})

test('does not offer APK handoff to store packages, old releases, skipped releases, or active reminders', async () => {
  const fetchRelease = releaseResponse({ android: { url: directApkUrl, version: '0.1.3', versionCode: 5 } })
  const base = { currentVersionCode: 4, fetchRelease, manifestUrl, now: 100 }

  assert.equal(await findDirectAndroidUpdate({ ...base, channel: 'store', preference: {} }), null)
  assert.equal(await findDirectAndroidUpdate({ ...base, channel: 'direct', preference: skipDirectAndroidUpdate(5) }), null)
  assert.equal(
    await findDirectAndroidUpdate({
      ...base,
      channel: 'direct',
      preference: remindAboutDirectAndroidUpdateLater(5, 100),
    }),
    null,
  )
})

test('a different newer release overrides a deferred earlier release', async () => {
  const update = await findDirectAndroidUpdate({
    channel: 'direct',
    currentVersionCode: 4,
    fetchRelease: releaseResponse({ android: { url: directApkUrl, version: '0.1.4', versionCode: 6 } }),
    manifestUrl,
    now: 100,
    preference: remindAboutDirectAndroidUpdateLater(5, 100),
  })

  assert.equal(update?.versionCode, 6)
  assert.equal(DIRECT_ANDROID_UPDATE_REMIND_AFTER_MS, 86_400_000)
})

test('invalid stored state fails closed', () => {
  assert.deepEqual(parseDirectAndroidUpdatePreference('{not json'), {})
  assert.deepEqual(parseDirectAndroidUpdatePreference('{"skippedVersionCode": 5}'), { skippedVersionCode: 5 })
})
