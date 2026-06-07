import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
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

export default function LoginScreen(): React.JSX.Element {
  const { baseUrl, devLogin, passwordLogin, setBaseUrl, status } = useAuth()
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
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            disabled={busy}
            onPress={() => void runLogin(() => passwordLogin({ email, password }))}
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
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

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    backgroundColor: '#1f2937',
    borderRadius: 10,
    marginTop: 24,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonSecondary: {
    alignItems: 'center',
    borderColor: '#1f2937',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
    paddingVertical: 14,
  },
  buttonSecondaryText: { color: '#1f2937', fontSize: 16, fontWeight: '600' },
  buttonText: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  error: { color: '#b91c1c', marginTop: 12 },
  flex: { flex: 1 },
  input: {
    borderColor: '#d1d5db',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  label: { color: '#374151', fontSize: 13, fontWeight: '600', marginTop: 16 },
  safe: { backgroundColor: '#ffffff', flex: 1 },
  subtitle: { color: '#6b7280', fontSize: 15, marginTop: 4 },
  title: { color: '#111827', fontSize: 32, fontWeight: '700' },
})
