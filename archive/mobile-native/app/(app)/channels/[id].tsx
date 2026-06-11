import { Stack, useLocalSearchParams } from 'expo-router'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'

import type { ThreadMessageRecord } from '@nessie/client-core'

import { useChannel, useSendMessage, useThreadMessages } from '../../../src/lib/queries'
import { useTheme } from '../../../src/lib/theme-context'
import type { ThemePalette } from '../../../src/lib/theme'

type ThreadStyles = ReturnType<typeof createStyles>

const MessageBubble = ({
  message,
  styles,
}: {
  message: ThreadMessageRecord
  styles: ThreadStyles
}): React.JSX.Element => {
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
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
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
  const error = channelQuery.error ?? messagesQuery.error
  const channelMissing = !loading && !channelQuery.error && !channelQuery.data
  const refreshing = channelQuery.isRefetching || messagesQuery.isRefetching
  const canShowComposer = !loading && !error && !channelMissing && Boolean(threadId)
  const canSend = Boolean(draft.trim() && threadId) && !sendMessage.isPending

  const refreshThread = async (): Promise<void> => {
    await channelQuery.refetch()
    if (threadId) {
      await messagesQuery.refetch()
    }
  }

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
            <ActivityIndicator color={theme.accent} size="large" />
          </View>
        ) : error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error.message}</Text>
            <Pressable
              disabled={refreshing}
              onPress={() => void refreshThread()}
              style={[styles.retryButton, refreshing && styles.retryButtonDisabled]}
            >
              {refreshing ? (
                <ActivityIndicator color={theme.onAccent} />
              ) : (
                <Text style={styles.retryButtonText}>Retry</Text>
              )}
            </Pressable>
          </View>
        ) : channelMissing ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Channel not found.</Text>
            <Pressable
              disabled={refreshing}
              onPress={() => void refreshThread()}
              style={[styles.retryButton, refreshing && styles.retryButtonDisabled]}
            >
              {refreshing ? (
                <ActivityIndicator color={theme.onAccent} />
              ) : (
                <Text style={styles.retryButtonText}>Retry</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <FlatList
            data={inverted}
            inverted
            keyExtractor={(message) => message.id}
            renderItem={({ item }) => <MessageBubble message={item} styles={styles} />}
            contentContainerStyle={styles.listContent}
            ListEmptyComponent={<Text style={styles.empty}>No messages yet.</Text>}
            refreshControl={
              <RefreshControl
                colors={[theme.accent]}
                progressBackgroundColor={theme.panel}
                refreshing={refreshing}
                tintColor={theme.accent}
                onRefresh={() => void refreshThread()}
              />
            }
          />
        )}
        {canShowComposer ? (
          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message"
              placeholderTextColor={theme.tx3}
              selectionColor={theme.accent}
              multiline
            />
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendDisabled]}
              disabled={!canSend}
              onPress={onSend}
            >
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const createStyles = (theme: ThemePalette) => StyleSheet.create({
  bubble: { borderRadius: 14, maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 9 },
  bubbleMine: { backgroundColor: theme.accent },
  bubbleOther: { backgroundColor: theme.mainHover },
  bubbleRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 4 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubbleRowOther: { justifyContent: 'flex-start' },
  bubbleText: { color: theme.tx, fontSize: 15 },
  bubbleTextMine: { color: theme.onAccent, fontSize: 15 },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  composer: {
    alignItems: 'flex-end',
    backgroundColor: theme.main,
    borderTopColor: theme.sep,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  composerInput: {
    backgroundColor: theme.panel,
    borderColor: theme.borderStrong,
    borderRadius: 18,
    borderWidth: 1,
    color: theme.tx,
    flex: 1,
    maxHeight: 120,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  empty: { color: theme.tx3, padding: 24, textAlign: 'center' },
  error: { color: theme.dangerText, paddingHorizontal: 24, textAlign: 'center' },
  flex: { flex: 1 },
  listContent: { paddingVertical: 8 },
  retryButton: {
    alignItems: 'center',
    backgroundColor: theme.accent,
    borderRadius: 10,
    justifyContent: 'center',
    marginTop: 16,
    minWidth: 96,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  retryButtonDisabled: { opacity: 0.6 },
  retryButtonText: { color: theme.onAccent, fontWeight: '600' },
  safe: { backgroundColor: theme.main, flex: 1 },
  sendButton: {
    backgroundColor: theme.accent,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendDisabled: { opacity: 0.5 },
  sendText: { color: theme.onAccent, fontWeight: '600' },
})
