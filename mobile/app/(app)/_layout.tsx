import { Redirect, Stack } from 'expo-router'

import { useAuth } from '../../src/lib/auth-context'

// Auth guard for the authenticated section. Anything under /(app) requires a
// valid session; otherwise we bounce to /login.
export default function AppLayout(): React.JSX.Element {
  const { status } = useAuth()

  if (status === 'signed-out') {
    return <Redirect href="/login" />
  }

  return (
    <Stack>
      <Stack.Screen name="channels/index" options={{ title: 'Channels' }} />
      <Stack.Screen name="channels/[id]" options={{ title: 'Thread' }} />
    </Stack>
  )
}
