import { useEffect, useState } from 'react'
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
      description={`Version ${update.version} is available (you have ${update.currentVersion}).`}
      dismissDisabled={installing || savingPreference}
      onClose={remindLater}
      open
      title="Update Nessie?"
    >
      <div className="flex flex-col gap-4 p-4">
        <p className="m-0 text-sm text-[color:var(--tx2)]">
          {update.body?.trim() || 'Install the latest signed Nessie update now?'}
        </p>
        {installError ? (
          <p className="m-0 text-sm text-[color:var(--danger)]" role="alert">
            The update could not be installed. Please try again later.
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="admin-button admin-button-secondary" disabled={savingPreference} onClick={skip} type="button">
            Skip this version
          </button>
          <button className="admin-button admin-button-secondary" disabled={savingPreference} onClick={remindLater} type="button">
            Remind me tomorrow
          </button>
          <button className="admin-button admin-button-primary" disabled={installing || savingPreference} onClick={() => void install()} type="button">
            {installing ? 'Installing…' : 'Update now'}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
