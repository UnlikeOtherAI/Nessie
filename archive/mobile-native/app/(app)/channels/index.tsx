import { Link, Stack } from 'expo-router'
import { useMemo } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import type { ChannelRecord } from '@nessie/client-core'

import { useAuth } from '../../../src/lib/auth-context'
import { useChannels } from '../../../src/lib/queries'
import { useTheme } from '../../../src/lib/theme-context'
import type { ThemePalette } from '../../../src/lib/theme'

type ChannelStyles = ReturnType<typeof createStyles>

const ChannelRow = ({
  channel,
  styles,
}: {
  channel: ChannelRecord
  styles: ChannelStyles
}): React.JSX.Element => (
  <Link href={`/(app)/channels/${channel.id}`} asChild>
    <Pressable
      accessibilityLabel={`${channel.label}, ${channel.unreadCount} unread`}
      style={styles.row}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {channel.type === 'dm' ? '@ ' : '# '}
          {channel.label}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {channel.projectName} · {channel.teamName}
        </Text>
      </View>
      {channel.unreadCount > 0 ? <View style={styles.unreadDot} /> : null}
    </Pressable>
  </Link>
)

export default function ChannelsScreen(): React.JSX.Element {
  const { logout } = useAuth()
  const theme = useTheme()
  const styles = useMemo(() => createStyles(theme), [theme])
  const { data, error, isLoading, isRefetching, refetch } = useChannels()

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => void logout()} hitSlop={12}>
              <Text style={styles.logout}>Log out</Text>
            </Pressable>
          ),
        }}
      />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error.message}</Text>
          <Pressable
            disabled={isRefetching}
            onPress={() => void refetch()}
            style={[styles.retryButton, isRefetching && styles.retryButtonDisabled]}
          >
            {isRefetching ? (
              <ActivityIndicator color={theme.onAccent} />
            ) : (
              <Text style={styles.retryButtonText}>Retry</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(channel) => channel.id}
          renderItem={({ item }) => <ChannelRow channel={item} styles={styles} />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<Text style={styles.empty}>No channels yet.</Text>}
          refreshControl={
            <RefreshControl
              colors={[theme.accent]}
              progressBackgroundColor={theme.panel}
              refreshing={isRefetching}
              tintColor={theme.accent}
              onRefresh={() => void refetch()}
            />
          }
        />
      )}
    </View>
  )
}

const createStyles = (theme: ThemePalette) => StyleSheet.create({
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  container: { backgroundColor: theme.main, flex: 1 },
  empty: { color: theme.tx3, padding: 24, textAlign: 'center' },
  error: { color: theme.dangerText, paddingHorizontal: 24, textAlign: 'center' },
  logout: { color: theme.link, fontSize: 15, fontWeight: '600' },
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
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: { color: theme.tx, fontSize: 16, fontWeight: '600' },
  rowMain: { flex: 1 },
  rowMeta: { color: theme.tx3, fontSize: 13, marginTop: 2 },
  separator: { backgroundColor: theme.sep, height: 1, marginLeft: 16 },
  unreadDot: { backgroundColor: theme.accent, borderRadius: 5, height: 10, width: 10 },
})
