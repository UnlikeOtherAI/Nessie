import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const executeFile = promisify(execFile)
const bundleIdentifier = 'com.unlikeotherai.nessie.desktop'

const configuredProfile = process.env.NESSIE_DESKTOP_APPSTORE_PROFILE
const teamIdentifier = process.env.NESSIE_DESKTOP_SIGNING_TEAM_ID

if (!configuredProfile) {
  throw new Error('Set NESSIE_DESKTOP_APPSTORE_PROFILE to the Mac App Store Connect provisioning profile before creating a store build.')
}
if (!teamIdentifier || !/^[A-Za-z0-9]+$/.test(teamIdentifier)) {
  throw new Error('Set NESSIE_DESKTOP_SIGNING_TEAM_ID to the Apple Developer team that owns the Mac app.')
}

const source = isAbsolute(configuredProfile) ? configuredProfile : resolve(configuredProfile)
const profile = await readFile(source)

if (profile.length === 0) {
  throw new Error('NESSIE_DESKTOP_APPSTORE_PROFILE points to an empty file.')
}

const temporaryDirectory = await mkdtemp(join(tmpdir(), 'nessie-appstore-profile-'))
const decodedProfilePath = join(temporaryDirectory, 'profile.plist')
let metadata

try {
  const { stdout: decodedProfile } = await executeFile('/usr/bin/security', ['cms', '-D', '-i', source], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  await writeFile(decodedProfilePath, decodedProfile)
  const readValue = async (keyPath) => {
    const { stdout } = await executeFile('/usr/libexec/PlistBuddy', ['-c', `Print ${keyPath}`, decodedProfilePath], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    return stdout.trim()
  }
  const applicationIdentifier = await readValue(':Entitlements:com.apple.application-identifier')
    .catch(() => readValue(':Entitlements:application-identifier'))
  const [platform, profileTeamIdentifier, getTaskAllow, expirationDate] = await Promise.all([
    readValue(':Platform:0'),
    readValue(':TeamIdentifier:0'),
    readValue(':Entitlements:get-task-allow'),
    readValue(':ExpirationDate'),
  ])
  metadata = {
    applicationIdentifier,
    expirationDate,
    getTaskAllow: getTaskAllow.toLowerCase() === 'false' ? false : getTaskAllow,
    platform,
    teamIdentifier: profileTeamIdentifier,
  }
} catch {
  throw new Error('NESSIE_DESKTOP_APPSTORE_PROFILE is not a readable Apple provisioning profile.')
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}

if (metadata.platform !== 'OSX') {
  throw new Error('NESSIE_DESKTOP_APPSTORE_PROFILE is not a macOS provisioning profile.')
}
if (metadata.teamIdentifier !== teamIdentifier) {
  throw new Error('NESSIE_DESKTOP_APPSTORE_PROFILE belongs to a different Apple Developer team.')
}
if (metadata.applicationIdentifier !== `${teamIdentifier}.${bundleIdentifier}`) {
  throw new Error(`NESSIE_DESKTOP_APPSTORE_PROFILE does not authorize ${bundleIdentifier}.`)
}
if (metadata.getTaskAllow !== false) {
  throw new Error('NESSIE_DESKTOP_APPSTORE_PROFILE is a development profile, not a Mac App Store Connect distribution profile.')
}
const expirationTime = new Date(metadata.expirationDate).getTime()
if (!Number.isFinite(expirationTime) || expirationTime <= Date.now()) {
  throw new Error('NESSIE_DESKTOP_APPSTORE_PROFILE has expired.')
}

const destinationDirectory = resolve('src-tauri/appstore')
await mkdir(destinationDirectory, { recursive: true })
await copyFile(source, resolve(destinationDirectory, 'embedded.provisionprofile'))
