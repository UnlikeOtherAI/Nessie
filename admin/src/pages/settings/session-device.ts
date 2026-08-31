import type { SessionClientType } from '@nessie/schemas'

type SessionDeviceSource = {
  clientType: SessionClientType | null
  userAgent: string | null
}

export type SessionDevice = {
  detail: string
  name: string
}

const browserName = (userAgent: string): string => {
  if (/Edg(?:A|iOS)?\//.test(userAgent)) return 'Microsoft Edge'
  if (/SamsungBrowser\//.test(userAgent)) return 'Samsung Internet'
  if (/(?:OPR|Opera)\//.test(userAgent)) return 'Opera'
  if (/(?:FxiOS|Firefox)\//.test(userAgent)) return 'Firefox'
  if (/(?:CriOS|Chrome)\//.test(userAgent)) return 'Chrome'
  if (/Version\/[^ ]+.*Safari\//.test(userAgent)) return 'Safari'
  return 'Web browser'
}

const deviceName = (userAgent: string): { mobile: boolean; name: string } => {
  if (/iPad/.test(userAgent)) return { mobile: true, name: 'iPad' }
  if (/iPhone/.test(userAgent)) return { mobile: true, name: 'iPhone' }
  if (/Android/.test(userAgent)) {
    return { mobile: true, name: /Mobile/.test(userAgent) ? 'Android phone' : 'Android tablet' }
  }
  if (/Macintosh|Mac OS X/.test(userAgent)) return { mobile: false, name: 'Mac' }
  if (/Windows/.test(userAgent)) return { mobile: false, name: 'Windows PC' }
  if (/Linux/.test(userAgent)) return { mobile: false, name: 'Linux computer' }
  return { mobile: false, name: 'Unknown device' }
}

const nativeDevice: Record<SessionClientType, SessionDevice> = {
  'native-desktop': { name: 'Nessie desktop app', detail: 'Native app on Mac' },
  'native-ios': { name: 'Nessie iOS app', detail: 'Native app on iPhone or iPad' },
  'native-android': { name: 'Nessie Android app', detail: 'Native app on Android' },
  'native-mobile': { name: 'Nessie mobile app', detail: 'Native app' },
}

/** Turn opaque session metadata into the identity a person needs to act on. */
export const describeSessionDevice = (session: SessionDeviceSource): SessionDevice => {
  if (session.clientType) return nativeDevice[session.clientType]
  if (!session.userAgent) return { name: 'Unknown device', detail: 'Browser session' }

  const device = deviceName(session.userAgent)
  const browser = browserName(session.userAgent)
  return {
    name: `${browser} on ${device.name}`,
    detail: device.mobile ? 'Mobile browser session' : 'Browser session',
  }
}
