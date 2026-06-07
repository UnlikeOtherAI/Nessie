import { QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { createQueryClient } from '@nessie/client-core'

import { AuthProvider } from '../src/lib/auth-context'
import { useUnreadBadge } from '../src/lib/use-unread-badge'
import { useNotificationDeepLink } from '../src/lib/use-notification-deep-link'

// One QueryClient for the app lifetime. createQueryClient comes from
// client-core so web and mobile share the same defaults.
const queryClient = createQueryClient()

const RootNavigator = (): React.JSX.Element => {
  // Wire notification taps → channel deep links once, at the navigator root.
  useNotificationDeepLink()
  useUnreadBadge()
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" />
      <Stack.Screen name="(app)" />
    </Stack>
  )
}

export default function RootLayout(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <StatusBar style="auto" />
          <RootNavigator />
        </AuthProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}
