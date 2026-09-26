import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../components/shared/Dialog'
import {
  checkForDirectDesktopUpdate,
  installDirectDesktopUpdate,
  remindAboutDirectDesktopUpdateLater,
  skipDirectDesktopUpdate,
  type DirectDesktopUpdate,
} from '../lib/direct-desktop-updater'

/**
 * The native direct-download updater owns signature validation and install;
 * this hosted-admin component owns only the person's startup decision.
 */
export const DirectDesktopUpdatePrompt = () => {
  const { t } = useTranslation('nativeShell')
  const [update, setUpdate] = useState<DirectDesktopUpdate | null>(null)
  const [installError, setInstallError] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [savingPreference, setSavingPreference] = useState(false)

  useEffect(() => {
    let active = true
    void checkForDirectDesktopUpdate().then((available) => {
      if (active) setUpdate(available)
    })
    return () => {
      active = false
    }
  }, [])

  if (!update) return null

  const savePreference = async (save: (version: string) => Promise<void>): Promise<void> => {
    setSavingPreference(true)
    try {
      await save(update.version)
      setUpdate(null)
    } catch {
      setSavingPreference(false)
      setInstallError(true)
    }
  }

  const remindLater = (): void => void savePreference(remindAboutDirectDesktopUpdateLater)

  const skip = (): void => void savePreference(skipDirectDesktopUpdate)

  const install = async (): Promise<void> => {
    setInstallError(false)
    setInstalling(true)
    try {
      // Successful install restarts this app, except NSIS which exits it while
      // taking over the installer. A rejected signature leaves this dialog up.
      await installDirectDesktopUpdate()
    } catch {
      setInstalling(false)
      setInstallError(true)
    }
  }

  return (
    <Dialog
      description={t('desktopUpdate.description', { version: update.version, currentVersion: update.currentVersion })}
      dismissDisabled={installing || savingPreference}
      onClose={remindLater}
      open
      title={t('desktopUpdate.title')}
    >
      <div className="flex flex-col gap-4 p-4">
        <p className="m-0 text-sm text-[color:var(--tx2)]">
          {update.body?.trim() || t('desktopUpdate.installPrompt')}
        </p>
        {installError ? (
          <p className="m-0 text-sm text-[color:var(--danger)]" role="alert">
            {t('desktopUpdate.installError')}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="admin-button admin-button-secondary" disabled={savingPreference} onClick={skip} type="button">
            {t('desktopUpdate.skip')}
          </button>
          <button className="admin-button admin-button-secondary" disabled={savingPreference} onClick={remindLater} type="button">
            {t('desktopUpdate.remindLater')}
          </button>
          <button className="admin-button admin-button-primary" disabled={installing || savingPreference} onClick={() => void install()} type="button">
            {installing ? t('desktopUpdate.installing') : t('desktopUpdate.updateNow')}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
