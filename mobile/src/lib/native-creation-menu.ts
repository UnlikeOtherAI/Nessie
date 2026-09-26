import type { ComponentProps } from 'react'
import type MaterialIcons from '@expo/vector-icons/MaterialIcons'

import type { NativeCreationAction } from './native-shell-layout'

export type NativeCreationOption = {
  action: Exclude<NativeCreationAction, 'message'>
  icon: ComponentProps<typeof MaterialIcons>['name']
}

// The sheet's rows, in the order they are read. Message is deliberately not one
// of them: it is the morphing compose button the sheet grows out of, pinned to
// the bottom edge (`messageActionSlot`), so Agent is last of the rows and sits
// immediately above it — the same place it takes in the web create menu.
export const NATIVE_CREATION_OPTIONS: NativeCreationOption[] = [
  {
    action: 'project',
    icon: 'folder',
  },
  {
    action: 'channel',
    icon: 'tag',
  },
  {
    action: 'agent',
    icon: 'smart-toy',
  },
]

export type NativeCreationOptionColors = {
  glyph: string
  wash: string
  washOpacity: number
}

// Each row's badge washes a hue over the sheet surface and paints its glyph a
// darker shade of that hue — the same pairs and wash percentages as the web
// create menu's `.create-menu-icon-<kind>` rules in admin/src/styles.css.
// Message has no entry: it is the morphing compose button and keeps the theme
// accent.
export const NATIVE_CREATION_OPTION_COLORS: Record<
  NativeCreationOption['action'],
  NativeCreationOptionColors
> = {
  project: { glyph: '#a96400', wash: '#d98600', washOpacity: 0.19 },
  channel: { glyph: '#258143', wash: '#3ba55c', washOpacity: 0.19 },
  agent: { glyph: '#5b3ed6', wash: '#7a5af8', washOpacity: 0.18 },
}

export const shouldDismissNativeCreationMenu = ({
  creationOpen,
  dismissVersion,
  previousDismissVersion,
}: {
  creationOpen: boolean
  dismissVersion: number
  previousDismissVersion: number
}): boolean => creationOpen && dismissVersion !== previousDismissVersion

/**
 * Where the creation control lives, in window coordinates. `left` and `right`
 * are the lane's insets from the window edges — a phone's lane is the whole
 * screen, an iPad's is its pinned list column — and `bottom` is the lane's
 * floor, before the control's own breathing room.
 */
export type NativeCreationLane = {
  bottom: number
  left: number
  right: number
}

export type NativeCreationMenuMetrics = {
  collapsedBottom: number
  collapsedRight: number
  expandedBottom: number
  expandedRight: number
  messageActionWidth: number
  sheetBottom: number
}

export const NATIVE_CREATION_ACTION_SIZE = 62

// The sheet's own padding, which is also what insets the morphed Message
// button from the sheet's edges once it has taken the sheet's bottom row.
const SHEET_PADDING = 8

// How far the collapsed compose circle floats above its lane's floor.
const COLLAPSED_LANE_GAP = 18

/**
 * How much of the lane's floor the collapsed control covers. The surface
 * beneath it reserves exactly this much, so its last row stays reachable
 * rather than sitting under a button that never moves.
 */
export const NATIVE_CREATION_LANE_CLEARANCE =
  COLLAPSED_LANE_GAP + NATIVE_CREATION_ACTION_SIZE + SHEET_PADDING

/**
 * The control's two resting shapes: a compose circle standing on the lane's
 * floor, and the Message row inside the sheet that grew out of it. Kept pure
 * so the phone lane and the iPad's list-column lane are checkable without a
 * renderer.
 */
export const nativeCreationMenuMetrics = (
  lane: NativeCreationLane,
  windowWidth: number,
): NativeCreationMenuMetrics => {
  const sheetBottom = lane.bottom + SHEET_PADDING
  return {
    collapsedBottom: lane.bottom + COLLAPSED_LANE_GAP,
    collapsedRight: lane.right + 6,
    expandedBottom: sheetBottom + SHEET_PADDING,
    expandedRight: lane.right + SHEET_PADDING,
    messageActionWidth: Math.max(
      NATIVE_CREATION_ACTION_SIZE,
      windowWidth - lane.left - lane.right - SHEET_PADDING * 2,
    ),
    sheetBottom,
  }
}
