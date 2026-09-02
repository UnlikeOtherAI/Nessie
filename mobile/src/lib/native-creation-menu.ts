import type { ComponentProps } from 'react'
import type MaterialIcons from '@expo/vector-icons/MaterialIcons'

import type { NativePhoneCreationAction } from './native-shell-layout'

export type NativeCreationOption = {
  accessibilityLabel: string
  action: NativePhoneCreationAction
  description: string
  icon: ComponentProps<typeof MaterialIcons>['name']
  title: string
}

// The sheet's rows, in the order they are read. Message is deliberately not one
// of them: it is the morphing compose button the sheet grows out of, pinned to
// the bottom edge (`messageActionSlot`), so Agent is last of the rows and sits
// immediately above it — the same place it takes in the web create menu.
export const NATIVE_CREATION_OPTIONS: NativeCreationOption[] = [
  {
    accessibilityLabel: 'Create project',
    action: 'project',
    description: 'Organise work in a shared folder',
    icon: 'folder',
    title: 'Project',
  },
  {
    accessibilityLabel: 'Create channel',
    action: 'channel',
    description: 'Start a team conversation',
    icon: 'tag',
    title: 'Channel',
  },
  {
    accessibilityLabel: 'Create agent',
    action: 'agent',
    description: 'Design a new agent',
    icon: 'smart-toy',
    title: 'Agent',
  },
]

export const shouldDismissNativeCreationMenu = ({
  creationOpen,
  dismissVersion,
  previousDismissVersion,
}: {
  creationOpen: boolean
  dismissVersion: number
  previousDismissVersion: number
}): boolean => creationOpen && dismissVersion !== previousDismissVersion
