import { readFile } from 'node:fs/promises'

const tag = process.argv[2]
const updaterManifestUrl = process.env.NESSIE_UPDATER_MANIFEST_URL
  ?? 'https://github.com/UnlikeOtherAI/Nessie/releases/latest/download/latest.json'

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

const parseVersion = (value, label) => {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a SemVer string.`)
  }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(value.replace(/^v/, ''))
  if (!match) throw new Error(`${label} must be a valid SemVer value.`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  }
}

const comparePrerelease = (left, right) => {
  if (left.length === 0) return right.length === 0 ? 0 : 1
  if (right.length === 0) return -1
  const size = Math.max(left.length, right.length)
  for (let index = 0; index < size; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return a > b ? 1 : -1
  }
  return 0
}

const compareVersions = (left, right) => {
  const a = parseVersion(left, 'Desktop updater version')
  const b = parseVersion(right, 'Published desktop updater version')
  for (const field of ['major', 'minor', 'patch']) {
    if (a[field] !== b[field]) return a[field] > b[field] ? 1 : -1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

const readPublishedDesktopVersion = async () => {
  let response
  try {
    response = await fetch(updaterManifestUrl, {
      headers: { 'user-agent': 'Nessie-release-metadata' },
    })
  } catch (error) {
    throw new Error(`Could not read the published updater manifest: ${error.message}`)
  }
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Could not read the published updater manifest (HTTP ${response.status}).`)
  }
  const manifest = await response.json()
  if (!manifest || typeof manifest.version !== 'string') {
    throw new Error('The published updater manifest does not carry a desktop version.')
  }
  return manifest.version
}

const publishedDesktopVersion = await readPublishedDesktopVersion()
if (publishedDesktopVersion && compareVersions(desktop.version, publishedDesktopVersion) <= 0) {
  throw new Error(
    `Desktop updater version ${desktop.version} must be greater than the published ${publishedDesktopVersion}.`,
  )
}

console.log(JSON.stringify({
  tag,
  desktop: { version: desktop.version },
  android: { version: mobile.version, versionCode: mobile.android.versionCode },
  updater: { previousVersion: publishedDesktopVersion },
}, null, 2))
