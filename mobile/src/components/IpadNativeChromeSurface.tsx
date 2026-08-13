import { type PropsWithChildren } from 'react'
import { StyleSheet, View } from 'react-native'

import { IPAD_NATIVE_CHROME_HEIGHT, type IpadNativeChromeTheme } from '../lib/ipad-native-chrome'

type IpadNativeChromeSurfaceProps = PropsWithChildren<{
  theme: IpadNativeChromeTheme
}>

export const IpadNativeChromeSurface = ({
  children,
  theme,
}: IpadNativeChromeSurfaceProps): React.JSX.Element => (
  <View
    style={[
      styles.surface,
      { backgroundColor: theme.backgroundColor, borderColor: theme.borderColor },
    ]}
  >
    {children}
  </View>
)

const styles = StyleSheet.create({
  surface: {
    height: IPAD_NATIVE_CHROME_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    padding: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
  },
})
