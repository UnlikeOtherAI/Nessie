import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ShakeFeedbackContextValue = {
  // A screenshot captured by a device shake, waiting to be picked up by the
  // feedback composer. Null when none is pending.
  screenshot: File | null;
  setScreenshot: (file: File | null) => void;
};

const ShakeFeedbackContext = createContext<ShakeFeedbackContextValue | null>(null);

export const ShakeFeedbackProvider = ({ children }: { children: ReactNode }) => {
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const value = useMemo<ShakeFeedbackContextValue>(
    () => ({ screenshot, setScreenshot }),
    [screenshot],
  );
  return <ShakeFeedbackContext.Provider value={value}>{children}</ShakeFeedbackContext.Provider>;
};

// Always returns a value when used inside ShakeFeedbackProvider; the no-op
// fallback keeps the feedback composer usable in tests / off-shell renders.
export const useShakeFeedback = (): ShakeFeedbackContextValue => {
  const ctx = useContext(ShakeFeedbackContext);
  const fallback = useNoopShakeFeedback();
  return ctx ?? fallback;
};

const useNoopShakeFeedback = (): ShakeFeedbackContextValue => {
  const setScreenshot = useCallback(() => {}, []);
  return useMemo(() => ({ screenshot: null, setScreenshot }), [setScreenshot]);
};
