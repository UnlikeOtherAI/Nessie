import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { ScreenBarBack } from './screen-bar'

// Which stack layer the subtree renders in, so a header can publish its bar
// under the layer's own identity rather than its pathname (screen-bar.ts).
//
// `PhoneNavigationLayer` provides the route layer's key. A nested stage
// provides its own, because a stage's key embeds the section and depth it was
// pushed at and the stage component cannot compute those — and because its
// children are portalled from the page's React position, so they would
// otherwise read the *route* layer's key from here rather than the stage's.
export type ScreenBarLayer = {
  // The stage's own Back, for a pane inside it that owns the title and the
  // actions but not the way out. A stage knows its label and its unwind; the
  // pane rendering inside it does not, and on a wide layout is deliberately
  // given no `onBack` at all.
  back: ScreenBarBack | null
  // Whether this layer is a nested stage rather than a route's own layer.
  // Some components render in both — the Knowledge browser is the space's root
  // listing in the route layer *and* the live pane inside an open folder
  // stage; a column browser's column 0 is the page itself. Those must publish
  // from the stage only, or they win by mount order over the page's own header
  // and the bar names the wrong screen. It is declared here rather than
  // inferred from the key's shape.
  isStage: boolean
  layerKey: string | null
}

const ScreenBarLayerContext = createContext<ScreenBarLayer>({
  back: null,
  isStage: false,
  layerKey: null,
})

export const ScreenBarLayerProvider = ({
  back = null,
  children,
  isStage = false,
  layerKey,
}: {
  back?: ScreenBarBack | null
  children: ReactNode
  isStage?: boolean
  layerKey: string | null
}) => {
  const value = useMemo(() => ({ back, isStage, layerKey }), [back, isStage, layerKey])
  return (
    <ScreenBarLayerContext.Provider value={value}>
      {children}
    </ScreenBarLayerContext.Provider>
  )
}

export const useScreenBarLayer = (): ScreenBarLayer => useContext(ScreenBarLayerContext)

export const useScreenBarLayerKey = (): string | null => useContext(ScreenBarLayerContext).layerKey
