import { readFile } from 'node:fs/promises'

const tag = process.argv[2]

if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error('Release tags must use the vMAJOR.MINOR.PATCH format.')
}

const [desktopConfig, mobileConfig] = await Promise.all([
  readFile(new URL('../desktop/src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  readFile(new URL('../mobile/app.json', import.meta.url), 'utf8'),
])

const desktop = JSON.parse(desktopConfig)
const mobile = JSON.parse(mobileConfig).expo

if (!desktop.version || !mobile.version || !Number.isInteger(mobile.android?.versionCode)) {
  throw new Error('The desktop and Android application versions must be explicit release metadata.')
}

console.log(JSON.stringify({
  tag,
  desktop: { version: desktop.version },
  android: { version: mobile.version, versionCode: mobile.android.versionCode },
}, null, 2))
