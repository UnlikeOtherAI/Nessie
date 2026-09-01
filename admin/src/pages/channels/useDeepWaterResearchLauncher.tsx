import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { DeepWaterResearchLauncherPreset } from '../../lib/api-client'
import { DeepWaterResearchLauncherDialog } from '../../components/features/integrations/DeepWaterResearchLauncherDialog'
import { readDeepWaterResearchLauncherPreset } from '../../facades/integrations/deep-water-research-launcher-navigation'
import { useIntegratedProducts } from '../../facades/integrations/hooks'

// Own transient launcher state at the channel-page boundary for both entry points.
export const useDeepWaterResearchLauncher = (message: string) => {
  const location = useLocation()
  const navigate = useNavigate()
  const { data: integratedProducts = [] } = useIntegratedProducts()
  const [preset, setPreset] = useState<DeepWaterResearchLauncherPreset | null>(null)
  const product = useMemo(
    () => integratedProducts.find((entry) => entry.slug === 'deep-water'),
    [integratedProducts],
  )

  useEffect(() => {
    const requestedPreset = readDeepWaterResearchLauncherPreset(location.state)
    if (!requestedPreset) {
      return
    }
    setPreset(requestedPreset)
    navigate(
      { hash: location.hash, pathname: location.pathname, search: location.search },
      { replace: true, state: null },
    )
  }, [location.hash, location.pathname, location.search, location.state, navigate])

  return {
    dialog: product && preset ? (
      <DeepWaterResearchLauncherDialog
        initialValues={preset}
        onClose={() => setPreset(null)}
        onLaunched={(researchChannelId) => void navigate(`/channels/${researchChannelId}`)}
        open
        product={product}
      />
    ) : null,
    open: product ? () => setPreset({ query: message.trim() || undefined }) : undefined,
  }
}
