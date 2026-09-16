import { requireOptionalNativeModule } from 'expo-modules-core'

import type { IpadKeyCommandId, NativeKeyCommand } from '../../src/lib/ipad-key-commands'

/**
 * The native iPad hardware-keyboard registrar.
 *
 * iPad-only. `requireOptionalNativeModule` makes "unavailable" a readable state
 * on iPhone, on Android, and in an installed build that predates this module, so
 * the shell only wires shortcuts where they can take effect — the same graceful
 * pattern as `nessie-app-icon`.
 *
 * This module owns no command semantics. It is handed the serialized table from
 * `ipad-key-commands.ts`, builds one `UIKeyCommand` per row (so holding ⌘ raises
 * the discoverability overlay), and reports the fired row's `id` back. What an
 * id *means* is resolved in TypeScript.
 */

export type KeyCommandEvent = { id: IpadKeyCommandId }

type NessieKeyCommandsNativeModule = {
  isSupported: () => boolean
  register: (commands: NativeKeyCommand[]) => void
  addListener: (
    event: 'onKeyCommand',
    listener: (payload: KeyCommandEvent) => void,
  ) => { remove: () => void }
}

const nativeModule = requireOptionalNativeModule<NessieKeyCommandsNativeModule>('NessieKeyCommands')

/** True only where the native registrar exists and the device is an iPad. */
export const areKeyCommandsSupported = (): boolean => nativeModule?.isSupported() === true

/** Install the commands so iPadOS lists and dispatches them. A no-op if unavailable. */
export const registerKeyCommands = (commands: NativeKeyCommand[]): void => {
  nativeModule?.register(commands)
}

/**
 * Subscribe to fired commands. Returns an unsubscribe function; a no-op
 * unsubscribe when the module is unavailable, so callers need no branch.
 */
export const addKeyCommandListener = (
  listener: (payload: KeyCommandEvent) => void,
): (() => void) => {
  const subscription = nativeModule?.addListener('onKeyCommand', listener)
  return () => subscription?.remove()
}
