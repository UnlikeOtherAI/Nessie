import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  NATIVE_PUSH_TOKEN_EVENT,
  NATIVE_PUSH_UNREGISTER_EVENT,
  readNativePushRegistration,
  shouldRegisterNativePush,
} from '../lib/native-push-registration';
import { isReactNativeWebView, readNativePendingPushPath } from '../lib/mobile-shell';
import { useApiClient } from './ApiClientProvider';
import { useAuthSession } from './AuthSessionProvider';
import { useShakeFeedback } from './ShakeFeedbackContext';

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __nessieNavigate?: (path: string) => void;
  __nessieOpenSearchOverlay?: () => void;
  __nessieCloseSearchOverlay?: () => void;
  __nessieShakeScreenshot?: (dataUri: string) => void;
};

const NATIVE_PUSH_PATH_EVENT = 'nessie:native-push-path';

// Decode a `data:image/...;base64,...` URI (sent by the native shell after a
// screen capture) into a File the feedback composer can upload like any other
// attachment.
const dataUriToFile = (dataUri: string, filename: string): File | null => {
  const comma = dataUri.indexOf(',');
  if (comma === -1) return null;
  const meta = dataUri.slice(0, comma);
  const base64 = dataUri.slice(comma + 1);
  const mime = meta.match(/data:(.*?);base64/)?.[1] ?? 'image/png';
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new File([bytes], filename, { type: mime });
  } catch {
    return null;
  }
};

// Bridges the React Native shell and the SPA: the native tab bar calls
// window.__nessieNavigate to drive routing, the shake handler calls
// window.__nessieShakeScreenshot to deliver a screenshot, and the SPA reports
// its route back so the native tab bar can sync its selected tab. Mounted only
// inside the native shell; renders nothing.
export const NativeShellBridge = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const apiClient = useApiClient();
  const { sessionMode } = useAuthSession();
  const { setScreenshot } = useShakeFeedback();
  const registeredToken = useRef<string | null>(null);
  const registeredApiClient = useRef<typeof apiClient | null>(null);
  const pendingToken = useRef<string | null>(null);
  const pendingRegistrations = useRef(new Set<Promise<void>>());

  useEffect(() => {
    if (!isReactNativeWebView()) {
      return undefined;
    }
    const navigateToCachedPushPath = (): void => {
      const path = readNativePendingPushPath();
      if (path) navigate(path);
    };
    // The native side preserves the path on window before emitting this event.
    // Calling it once here handles a cold-start event that predated React.
    window.addEventListener(NATIVE_PUSH_PATH_EVENT, navigateToCachedPushPath);
    navigateToCachedPushPath();
    return () => window.removeEventListener(NATIVE_PUSH_PATH_EVENT, navigateToCachedPushPath);
  }, [navigate]);

  useEffect(() => {
    if (!shouldRegisterNativePush(isReactNativeWebView(), sessionMode)) {
      return undefined;
    }
    const register = (event: Event): void => {
      const registration = readNativePushRegistration(event);
      if (
        !registration
        || (
          registeredToken.current === registration.token
          && registeredApiClient.current === apiClient
        )
      ) {
        return;
      }
      pendingToken.current = registration.token;
      const registrationRequest: Promise<void> = apiClient.post('/api/devices', registration)
        .then(() => {
          registeredToken.current = registration.token;
          registeredApiClient.current = apiClient;
        })
        .catch(() => undefined);
      pendingRegistrations.current.add(registrationRequest);
      void registrationRequest.finally(() => pendingRegistrations.current.delete(registrationRequest));
    };
    const unregister = (event: Event): void => {
      const complete = (event as CustomEvent<{ complete?: unknown }>).detail?.complete;
      const finish: () => void = typeof complete === 'function'
        ? (complete as () => void)
        : () => undefined;
      void (async () => {
        // Do not let an earlier registration complete after this delete and
        // recreate a signed-out user's device binding.
        await Promise.all([...pendingRegistrations.current]);
        const token = pendingToken.current ?? registeredToken.current;
        pendingToken.current = null;
        registeredToken.current = null;
        registeredApiClient.current = null;
        if (!token) {
          finish();
          return;
        }
        await apiClient.delete(`/api/devices/${encodeURIComponent(token)}`).catch(() => undefined);
        finish();
      })();
    };
    window.addEventListener(NATIVE_PUSH_TOKEN_EVENT, register);
    window.addEventListener(NATIVE_PUSH_UNREGISTER_EVENT, unregister);
    // Imported debug access is intentionally ephemeral and never reaches this
    // branch. Renewable sessions ask the shell to repost its cached token after
    // every API-client change, including a workspace switch.
    (window as RnWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: 'nessie:request-push-registration' }),
    );
    return () => {
      window.removeEventListener(NATIVE_PUSH_TOKEN_EVENT, register);
      window.removeEventListener(NATIVE_PUSH_UNREGISTER_EVENT, unregister);
    };
  }, [apiClient, sessionMode]);

  useEffect(() => {
    if (!isReactNativeWebView()) {
      return undefined;
    }
    const target = window as RnWindow;
    target.__nessieNavigate = (path: string) => {
      if (typeof path === 'string' && path.length > 0) {
        navigate(path);
      }
    };
    target.__nessieOpenSearchOverlay = () => {
      window.dispatchEvent(new Event('nessie:open-search-overlay'));
    };
    target.__nessieCloseSearchOverlay = () => {
      window.dispatchEvent(new Event('nessie:close-search-overlay'));
    };
    target.__nessieShakeScreenshot = (dataUri: string) => {
      const file = dataUriToFile(dataUri, `feedback-${Date.now()}.png`);
      if (file) {
        setScreenshot(file);
      }
    };
    return () => {
      delete target.__nessieNavigate;
      delete target.__nessieOpenSearchOverlay;
      delete target.__nessieCloseSearchOverlay;
      delete target.__nessieShakeScreenshot;
    };
  }, [navigate, setScreenshot]);

  useEffect(() => {
    if (!isReactNativeWebView()) {
      return;
    }
    (window as RnWindow).ReactNativeWebView?.postMessage(
      JSON.stringify({ type: 'nessie:route', path: `${location.pathname}${location.search}` }),
    );
  }, [location.pathname, location.search]);

  return null;
};
