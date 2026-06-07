import { Stack, useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import type { ThreadMessageRecord } from '@nessie/client-core'

import { useChannel, useSendMessage, useThreadMessages } from '../../../src/lib/queries'

const MessageBubble = ({ message }: { message: ThreadMessageRecord }): React.JSX.Element => {
  const mine = message.role === 'user'
  return (
    <View style={[styles.bubbleRow, mine ? styles.bubbleRowMine : styles.bubbleRowOther]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
        <Text style={mine ? styles.bubbleTextMine : styles.bubbleText}>{message.content}</Text>
      </View>
    </View>
  )
}

export default function ThreadScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>()
  const channelQuery = useChannel(id)
  const threadId = channelQuery.data?.defaultThreadId
  const messagesQuery = useThreadMessages(threadId)
  const sendMessage = useSendMessage(threadId)

  const [draft, setDraft] = useState('')

  // API returns oldest-first; render newest at the bottom via an inverted list.
  const inverted = useMemo(
    () => (messagesQuery.data ? [...messagesQuery.data].reverse() : []),
    [messagesQuery.data],
  )

  const onSend = (): void => {
    const content = draft.trim()
    if (!content || !threadId) {
      return
    }
    setDraft('')
    sendMessage.mutate(content)
  }

  const loading = channelQuery.isLoading || messagesQuery.isLoading

  return (
    <SafeAreaView style={styles.safe} edges={['bottom']}>
      <Stack.Screen options={{ title: channelQuery.data?.label ?? 'Thread' }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={88}
        style={styles.flex}
      >
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" />
          </View>
        ) : (
          <FlatList
            data={inverted}
            inverted
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => <MessageBubble message={item} />}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
          />
        )}
        <View style={styles.composer}>
          <TextInput
            style={styles.composerInput}
            value={draft}
            onChangeText={setDraft}
            placeholder="Message"
            multiline
          />
          <Pressable
            style={[styles.sendButton, (!draft.trim() || sendMessage.isPending) && styles.sendDisabled]}
            disabled={!draft.trim() || sendMessage.isPending}
            onPress={onSend}
          >
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  bubble: { borderRadius: 14, maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 9 },
  bubbleMine: { backgroundColor: '#2563eb' },
  bubbleOther: { backgroundColor: '#f3f4f6' },
  bubbleRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 4 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  bubbleText: { color: '#111827', fontSize: 15 },
  bubbleTextMine: { color: '#ffffff', fontSize: 15 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  composer: {
    alignItems: 'flex-end',
    borderTopColor: '#e5e7eb',
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  composerInput: {
    borderColor: '#d1d5db',
    borderRadius: 18,
    borderWidth: 1,
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  empty: { color: '#6b7280', padding: 24, textAlign: 'center' },
  flex: { flex: 1 },
  listContent: { paddingVertical: 8 },
  safe: { backgroundColor: '#ffffff', flex: 1 },
  sendButton: {
    backgroundColor: '#2563eb',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: '#ffffff', fontWeight: '600' },
})
