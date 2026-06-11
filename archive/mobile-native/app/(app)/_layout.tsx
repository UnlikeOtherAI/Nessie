import { Redirect, Stack } from 'expo-router'

import { useAuth } from '../../src/lib/auth-context'
import { useTheme } from '../../src/lib/theme-context'

// Auth guard for the authenticated section. Anything under /(app) requires a
// valid session; otherwise we bounce to /login.
export default function AppLayout(): React.JSX.Element {
  const { status } = useAuth()
  const theme = useTheme()

  if (status === 'signed-out') {
    return <Redirect href="/login" />
  }

  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: theme.main },
        headerStyle: { backgroundColor: theme.panel },
        headerTintColor: theme.tx,
        headerTitleStyle: { color: theme.tx },
      }}
    >
      <Stack.Screen name="channels/index" options={{ title: 'Channels' }} />
      <Stack.Screen name="channels/[id]" options={{ title: 'Thread' }} />
    </Stack>
  )
}
