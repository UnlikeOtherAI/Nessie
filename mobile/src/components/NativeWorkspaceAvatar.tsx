import { Image, StyleSheet, Text, View } from 'react-native'
import { useState } from 'react'

type NativeWorkspaceAvatarProps = {
  backgroundColor: string
  imageUrl: string | null
  label: string
  size: number
  textColor: string
}

const initial = (label: string): string => [...label.trim()][0]?.toUpperCase() ?? 'W'

/** Shared workspace picture for the native iPhone and iPad header triggers. */
export const NativeWorkspaceAvatar = ({
  backgroundColor,
  imageUrl,
  label,
  size,
  textColor,
}: NativeWorkspaceAvatarProps): React.JSX.Element => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = Boolean(imageUrl && imageUrl !== failedUrl)

  return (
    <View
      style={[
        styles.avatar,
        { backgroundColor, borderRadius: Math.round(size / 4), height: size, width: size },
      ]}
    >
      {showImage ? (
        <Image
          accessible={false}
          onError={() => setFailedUrl(imageUrl)}
          source={{ uri: imageUrl ?? undefined }}
          style={StyleSheet.absoluteFillObject}
        />
      ) : (
        <Text style={[styles.initial, { color: textColor }]}>{initial(label)}</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initial: {
    fontSize: 14,
    fontWeight: '700',
  },
})
