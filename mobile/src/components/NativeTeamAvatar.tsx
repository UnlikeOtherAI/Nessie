import { Image, StyleSheet, Text, View } from 'react-native'
import { SvgXml } from 'react-native-svg'
import { useEffect, useState } from 'react'

import { identityInitials, identityTileRadius } from '../lib/identity-shape'

type NativeIdentityAvatarProps = {
  backgroundColor: string
  imageUrl: string | null
  label: string
  size: number
  textColor: string
  /** Initials shown before any picture resolves, and when none exists. */
  initialsFallback?: string
  /**
   * 'tile' (the default) draws the shared rounded square used for a team
   * mark; 'circle' draws a person as a full circle. A team is a rounded
   * square and a person is a circle, matching the circular account button the
   * person's picture sits inside — a tile there left square corners inside the
   * ring.
   */
  shape?: 'tile' | 'circle'
}

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

/**
 * The one identity picture in the native chrome — the team mark and the
 * signed-in person alike.
 *
 * The person used to be drawn as a full circle here while the team beside
 * it was a rounded square, and the WebView an inch below drew both as rounded
 * squares. The radius now comes from the shared contract, so the native header
 * and the web app agree.
 */
export const NativeIdentityAvatar = ({
  backgroundColor,
  imageUrl,
  initialsFallback = 'W',
  label,
  size,
  textColor,
  shape = 'tile',
}: NativeIdentityAvatarProps): React.JSX.Element => {
  const [failedRasterUrl, setFailedRasterUrl] = useState<string | null>(null)
  const source = useAvatarImageSource(imageUrl)
  const showRaster = source.kind === 'raster' && source.uri !== failedRasterUrl

  return (
    <View
      style={[
        styles.avatar,
        {
          backgroundColor,
          borderRadius: shape === 'circle' ? size / 2 : identityTileRadius(size),
          height: size,
          width: size,
        },
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
        <Text style={[styles.initial, { color: textColor }]}>
          {identityInitials(label, initialsFallback)}
        </Text>
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

/**
 * Retained name for the team call sites. The team and the person are
 * the same tile; only the initials fallback differs.
 */
export const NativeTeamAvatar = NativeIdentityAvatar
