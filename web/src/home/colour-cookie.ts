import { defaultDeviceColour, deviceColours, type DeviceColour } from './content'

// The desktop's case colour is a preference, kept for a year in a first-party
// cookie. Reads and writes are guarded: some contexts block cookie access.

const cookieName = 'nessie-device-colour'
const maxAgeSeconds = 60 * 60 * 24 * 365

function findColour(id: string | undefined): DeviceColour | undefined {
  return deviceColours.find((colour) => colour.id === id)
}

export function readDeviceColour(): DeviceColour {
  let saved: string | undefined
  try {
    saved = document.cookie
      .split('; ')
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1)
  } catch {
    saved = undefined
  }
  const fallback = findColour(defaultDeviceColour) ?? deviceColours[0]
  if (!fallback) throw new Error('deviceColours is empty')
  return findColour(saved ? decodeURIComponent(saved) : undefined) ?? fallback
}

export function writeDeviceColour(colour: DeviceColour) {
  try {
    document.cookie = `${cookieName}=${encodeURIComponent(colour.id)}; Max-Age=${maxAgeSeconds}; Path=/; SameSite=Lax`
  } catch {
    // Cookies are blocked; the choice lasts for this page view only.
  }
}
