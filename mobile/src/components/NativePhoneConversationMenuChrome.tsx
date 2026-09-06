import { NativeCreationMenu } from './NativeCreationMenu'
import { NativePhoneHeader, type NativePhoneHeaderProps } from './NativePhoneHeader'
import {
  getNativePhoneBottomChromeClearance,
  type NativeCreationAction,
} from '../lib/native-shell-layout'

type NativePhoneConversationMenuChromeProps = NativePhoneHeaderProps & {
  bottomInset: number
  creationAccentColor: string
  dismissCreationMenuVersion: number
  onAccentColor: string
  onCreationMenuOpen: () => void
  onCreateAction: (action: NativeCreationAction) => void
  sheetMutedText: string
  sheetSurface: string
  sheetText: string
  showCreationActions: boolean
  platform: 'android' | 'ios'
}

// The phone's lane is the whole screen, inset from both edges. The iPad's is
// its pinned list column (App.tsx), which is why the control itself takes a
// lane rather than deriving one from the window.
const NATIVE_PHONE_CREATION_LANE_INSET = 16

/**
 * Native phone shell chrome for every tab's first screen. The controls are
 * native but delegate to the WebView's existing team, recents, account,
 * and compose actions, preserving their authorization and menus.
 */
export const NativePhoneConversationMenuChrome = ({
  accentColor,
  accountAvatarUrl,
  accountFocusModeEnabled,
  accountName,
  accountPresence,
  bottomInset,
  creationAccentColor,
  dismissCreationMenuVersion,
  headerSurface,
  headerText,
  landscape,
  onAccentColor,
  onAccountPress,
  onToggleFocusMode,
  onCreationMenuOpen,
  onToolbarAction,
  onCreateAction,
  safeTop,
  sheetMutedText,
  sheetSurface,
  sheetText,
  showCreationActions,
  toolbarState,
  platform,
  onTeamPress,
  teamAvatarUrl,
  teamName,
}: NativePhoneConversationMenuChromeProps): React.JSX.Element => (
  <>
    <NativePhoneHeader
      accentColor={accentColor}
      accountAvatarUrl={accountAvatarUrl}
      accountFocusModeEnabled={accountFocusModeEnabled}
      accountName={accountName}
      accountPresence={accountPresence}
      headerSurface={headerSurface}
      headerText={headerText}
      landscape={landscape}
      onAccountPress={onAccountPress}
      onToggleFocusMode={onToggleFocusMode}
      onToolbarAction={onToolbarAction}
      onTeamPress={onTeamPress}
      safeTop={safeTop}
      toolbarState={toolbarState}
      teamAvatarUrl={teamAvatarUrl}
      teamName={teamName}
    />

    {showCreationActions ? (
      <NativeCreationMenu
        accentColor={creationAccentColor}
        dismissVersion={dismissCreationMenuVersion}
        lane={{
          bottom: bottomInset + getNativePhoneBottomChromeClearance(platform),
          left: NATIVE_PHONE_CREATION_LANE_INSET,
          right: NATIVE_PHONE_CREATION_LANE_INSET,
        }}
        onAccentColor={onAccentColor}
        onOpen={onCreationMenuOpen}
        onSelect={onCreateAction}
        sheetMutedText={sheetMutedText}
        sheetSurface={sheetSurface}
        sheetText={sheetText}
      />
    ) : null}
  </>
)
