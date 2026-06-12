import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isReactNativeWebView } from '../lib/mobile-shell';
import { useShakeFeedback } from './ShakeFeedbackContext';

type RnWindow = Window & {
  ReactNativeWebView?: { postMessage: (data: string) => void };
  __nessieNavigate?: (path: string) => void;
  __nessieOpenSearchOverlay?: () => void;
  __nessieCloseSearchOverlay?: () => void;
  __nessieShakeScreenshot?: (dataUri: string) => void;
};

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
  const { setScreenshot } = useShakeFeedback();

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
      JSON.stringify({ type: 'nessie:route', path: location.pathname }),
    );
  }, [location.pathname]);

  return null;
};
