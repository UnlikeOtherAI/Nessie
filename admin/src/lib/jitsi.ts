let loadPromise: Promise<void> | null = null

export const JITSI_DOMAIN = 'meet.jit.si'

export function loadJitsiApi(): Promise<void> {
  if (loadPromise) return loadPromise
  if ((window as unknown as Record<string, unknown>).JitsiMeetExternalAPI) return Promise.resolve()
  loadPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `https://${JITSI_DOMAIN}/external_api.js`
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Jitsi API'))
    document.head.appendChild(s)
  })
  return loadPromise
}
