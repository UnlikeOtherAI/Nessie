import { useNativeIOSPhoneApp } from '../../lib/mobile-shell'

type PhoneBackButtonProps = {
  label: string
  onBack: () => void
}

// The shared mobile Back doorway is intentionally independent of a page's
// routing. Pages and the shell choose the safe parent route; this component
// makes that action visually consistent across channel, project, and admin
// surfaces.
export const PhoneBackButton = ({ label, onBack }: PhoneBackButtonProps) => {
  const nativeIOSPhone = useNativeIOSPhoneApp()

  return (
    <button
      aria-label={label}
      className={[
        'flex h-9 w-9 flex-shrink-0 items-center justify-center transition-colors',
        nativeIOSPhone
          ? [
              'rounded-full border border-white/35 bg-white/65 text-[color:var(--tx)] shadow-sm',
              'backdrop-blur-xl active:bg-white/85 dark:border-white/20 dark:bg-black/25',
            ].join(' ')
          : 'rounded-full text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
      ].join(' ')}
      onClick={onBack}
      type="button"
    >
      <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.1" viewBox="0 0 24 24">
        <path d="m15 19-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}
