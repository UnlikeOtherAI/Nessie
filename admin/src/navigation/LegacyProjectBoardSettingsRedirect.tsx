import { useLocation } from 'react-router-dom'
import { RedirectRoute } from './RedirectRoute'
import { legacyProjectBoardSettingsTarget } from './intent'

/**
 * The retired Boards settings address is a redirect, not a screen that reads
 * an intent. It carries a one-shot create instruction to the new directory,
 * where `useConsumedIntent` owns stripping and opening the dialog.
 */
export const LegacyProjectBoardSettingsRedirect = ({ projectId }: { projectId: string }) => {
  const { search } = useLocation()
  return <RedirectRoute to={legacyProjectBoardSettingsTarget(projectId, search)} />
}
