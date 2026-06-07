import { Redirect } from 'expo-router'
import { ActivityIndicator, StyleSheet, View } from 'react-native'

import { useAuth } from '../src/lib/auth-context'

// Entry route: gate on auth status. While restoring the persisted session we
// show a spinner; afterwards we redirect to the app or the login screen.
export default function Index(): React.JSX.Element {
  const { status } = useAuth()

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    )
  }

  if (status === 'signed-in') {
    return <Redirect href="/(app)/channels" />
  }

  return <Redirect href="/login" />
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
})
