import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import { useAuth } from '../src/lib/auth-context'
import { useTheme } from '../src/lib/theme-context'
import type { ThemePalette } from '../src/lib/theme'

export default function LoginScreen(): React.JSX.Element {
  const { baseUrl, devLogin, passwordLogin, setBaseUrl, status } = useAuth()
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
  const router = useRouter()

  const [urlField, setUrlField] = useState(baseUrl)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keep the editable URL field in sync once the stored base URL is restored.
  useEffect(() => {
    setUrlField(baseUrl)
  }, [baseUrl])

  // A successful login flips auth status; bounce to the app.
  useEffect(() => {
    if (status === 'signed-in') {
      router.replace('/(app)/channels')
    }
  }, [router, status])

  const runLogin = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await setBaseUrl(urlField)
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.container}>
          <Text style={styles.title}>Nessie</Text>
          <Text style={styles.subtitle}>Sign in to your instance</Text>

          <Text style={styles.label}>API base URL</Text>
          <TextInput
            style={styles.input}
            value={urlField}
            onChangeText={setUrlField}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://localhost:5554"
            placeholderTextColor={theme.tx3}
            selectionColor={theme.accent}
          />

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            placeholder="you@example.com"
            placeholderTextColor={theme.tx3}
            selectionColor={theme.accent}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor={theme.tx3}
            selectionColor={theme.accent}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            disabled={busy}
            onPress={() => void runLogin(() => passwordLogin({ email, password }))}
          >
            {busy ? (
              <ActivityIndicator color={theme.onAccent} />
            ) : (
              <Text style={styles.buttonText}>Sign in</Text>
            )}
          </Pressable>

          <Pressable
            style={[styles.buttonSecondary, busy && styles.buttonDisabled]}
            disabled={busy}
            onPress={() => void runLogin(devLogin)}
          >
            <Text style={styles.buttonSecondaryText}>Dev login (localhost)</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const createStyles = (theme: ThemePalette) => StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: theme.accent,
    borderRadius: 10,
    marginTop: 24,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonSecondary: {
    alignItems: 'center',
    borderColor: theme.accent,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
    paddingVertical: 14,
  },
  buttonSecondaryText: { color: theme.accent, fontSize: 16, fontWeight: '600' },
  buttonText: { color: theme.onAccent, fontSize: 16, fontWeight: '600' },
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  error: { color: theme.dangerText, marginTop: 12 },
  flex: { flex: 1 },
  input: {
    backgroundColor: theme.panel,
    borderColor: theme.borderStrong,
    borderRadius: 10,
    borderWidth: 1,
    color: theme.tx,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  label: { color: theme.tx2, fontSize: 13, fontWeight: '600', marginTop: 16 },
  safe: { backgroundColor: theme.main, flex: 1 },
  subtitle: { color: theme.tx3, fontSize: 15, marginTop: 4 },
  title: { color: theme.tx, fontSize: 32, fontWeight: '700' },
})
