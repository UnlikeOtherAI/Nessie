import { Link, Stack } from 'expo-router'
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

const ChannelRow = ({ channel }: { channel: ChannelRecord }): React.JSX.Element => (
  <Link href={`/(app)/channels/${channel.id}`} asChild>
    <Pressable style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {channel.type === 'dm' ? '@ ' : '# '}
          {channel.label}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {channel.projectName} · {channel.teamName}
        </Text>
      </View>
      {channel.unreadCount > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{channel.unreadCount}</Text>
        </View>
      ) : null}
    </Pressable>
  </Link>
)

export default function ChannelsScreen(): React.JSX.Element {
  const { logout } = useAuth()
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
          <ActivityIndicator size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error.message}</Text>
        </View>
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(channel) => channel.id}
          renderItem={({ item }) => <ChannelRow channel={item} />}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={<Text style={styles.empty}>No channels yet.</Text>}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />
          }
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    backgroundColor: '#2563eb',
    borderRadius: 11,
    justifyContent: 'center',
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  center: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  container: { backgroundColor: '#ffffff', flex: 1 },
  empty: { color: '#6b7280', padding: 24, textAlign: 'center' },
  error: { color: '#b91c1c', paddingHorizontal: 24, textAlign: 'center' },
  logout: { color: '#2563eb', fontSize: 15, fontWeight: '600' },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowLabel: { color: '#111827', fontSize: 16, fontWeight: '600' },
  rowMain: { flex: 1 },
  rowMeta: { color: '#6b7280', fontSize: 13, marginTop: 2 },
  separator: { backgroundColor: '#f3f4f6', height: 1, marginLeft: 16 },
})
