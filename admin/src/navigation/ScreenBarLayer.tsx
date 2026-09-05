import { createContext, useContext, type ReactNode } from 'react'

// Which stack layer the subtree renders in, so a header can publish its bar
// under the layer's own identity rather than its pathname (screen-bar.ts).
//
// `PhoneNavigationLayer` provides the route layer's key. A nested stage
// provides its own, because a stage's key embeds the section and depth it was
// pushed at and the stage component cannot compute those — and because its
// children are portalled from the page's React position, so they would
// otherwise read the *route* layer's key from here rather than the stage's.
const ScreenBarLayerContext = createContext<string | null>(null)

export const ScreenBarLayerProvider = ({
  children,
  layerKey,
}: {
  children: ReactNode
  layerKey: string | null
}) => (
  <ScreenBarLayerContext.Provider value={layerKey}>
    {children}
  </ScreenBarLayerContext.Provider>
)

export const useScreenBarLayerKey = (): string | null => useContext(ScreenBarLayerContext)
