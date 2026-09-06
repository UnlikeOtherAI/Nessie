import { Outlet } from 'react-router-dom';
import { ExternalAuthRouterBridge } from '../bridges/ExternalAuthRouterBridge';
import { DirectDesktopUpdatePrompt } from '../bridges/DirectDesktopUpdatePrompt';
import { IncomingCallProvider } from '../providers/IncomingCallProvider';
import { NativeShellBridge } from '../bridges/NativeShellBridge';
import { ShakeFeedbackProvider } from '../providers/ShakeFeedbackContext';

// Wraps every route (including /login and /bootstrap) so the native shell bridge
// reports the route on all screens — the native tab bar needs to know when the
// app is on the auth gate to hide itself.
export const RootLayout = () => (
  <ShakeFeedbackProvider>
    <IncomingCallProvider>
      <NativeShellBridge />
      <ExternalAuthRouterBridge />
      <DirectDesktopUpdatePrompt />
      <Outlet />
    </IncomingCallProvider>
  </ShakeFeedbackProvider>
);
