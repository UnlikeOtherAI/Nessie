import { useEffect, useRef } from 'react'
import { Accelerometer } from 'expo-sensors'

// Accelerometer magnitude at rest is ~1g; a deliberate shake spikes well past
// this. Cooldown stops a single shake from firing repeatedly.
const SHAKE_THRESHOLD = 1.8
const SHAKE_COOLDOWN_MS = 2000
const UPDATE_INTERVAL_MS = 120

// Calls `onShake` when the device is shaken. Works on iOS, iPadOS and Android.
export const useShake = (onShake: () => void): void => {
  const lastFired = useRef(0)
  const callback = useRef(onShake)
  callback.current = onShake

  useEffect(() => {
    Accelerometer.setUpdateInterval(UPDATE_INTERVAL_MS)
    const subscription = Accelerometer.addListener(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z)
      if (magnitude < SHAKE_THRESHOLD) {
        return
      }
      const now = Date.now()
      if (now - lastFired.current < SHAKE_COOLDOWN_MS) {
        return
      }
      lastFired.current = now
      callback.current()
    })
    return () => subscription.remove()
  }, [])
}
