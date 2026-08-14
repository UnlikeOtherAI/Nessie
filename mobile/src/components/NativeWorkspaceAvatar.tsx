import { Image, StyleSheet, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { useEffect, useState } from 'react'

type NativeWorkspaceAvatarProps = {
  backgroundColor: string
  imageUrl: string | null
  label: string
  size: number
  textColor: string
}

const initial = (label: string): string => [...label.trim()][0]?.toUpperCase() ?? 'W'

type AvatarImageSource =
  | { kind: 'fallback' }
  | { kind: 'raster'; uri: string }
  | { kind: 'svg'; xml: string }

const contentType = (response: Response): string =>
  response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''

const useAvatarImageSource = (imageUrl: string | null): AvatarImageSource => {
  const [source, setSource] = useState<AvatarImageSource>({ kind: 'fallback' })

  useEffect(() => {
    if (!imageUrl) {
      setSource({ kind: 'fallback' })
      return undefined
    }

    setSource({ kind: 'fallback' })
    const controller = new AbortController()
    let active = true
    void fetch(imageUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Avatar request failed: ${response.status}`)
        if (!active) return
        if (contentType(response) !== 'image/svg+xml') {
          setSource({ kind: 'raster', uri: imageUrl })
          return
        }
        const xml = await response.text()
        if (!active || !xml.trim()) throw new Error('Avatar SVG is empty')
        setSource({ kind: 'svg', xml })
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setSource({ kind: 'fallback' })
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [imageUrl])

  return source
}

/** Shared workspace picture for the native iPhone and iPad header triggers. */
export const NativeWorkspaceAvatar = ({
  backgroundColor,
  imageUrl,
  label,
  size,
  textColor,
}: NativeWorkspaceAvatarProps): React.JSX.Element => {
  const [failedRasterUrl, setFailedRasterUrl] = useState<string | null>(null)
  const source = useAvatarImageSource(imageUrl)
  const showRaster = source.kind === 'raster' && source.uri !== failedRasterUrl

  return (
    <View
      style={[
        styles.avatar,
        { backgroundColor, borderRadius: Math.round(size / 4), height: size, width: size },
      ]}
    >
      {source.kind === 'svg' ? (
        <SvgXml height={size} width={size} xml={source.xml} />
      ) : showRaster ? (
        <Image
          accessible={false}
          onError={() => setFailedRasterUrl(source.uri)}
          source={{ uri: source.uri }}
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
