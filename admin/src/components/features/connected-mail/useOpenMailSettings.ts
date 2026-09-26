import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'

import {
  useConnectedMailSettingsPath,
  type MailSettingsTarget,
} from '../../../facades/mail/settings-path'

/**
 * Opens where a connected mail account is managed: a person's own on Connected
 * accounts, a shared mailbox on Company connections at its team's scope. The
 * press is the navigation, so it pushes like any other link.
 */
export const useOpenMailSettings = (): ((account: MailSettingsTarget) => void) => {
  const navigate = useNavigate()
  const settingsPath = useConnectedMailSettingsPath()
  return useCallback((account: MailSettingsTarget) => {
    void settingsPath(account).then((path) => navigate(path))
  }, [navigate, settingsPath])
}
