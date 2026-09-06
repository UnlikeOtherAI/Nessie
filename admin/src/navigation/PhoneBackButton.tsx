import { useNativeIOSPhoneApp } from './mobile-shell'

export type PhoneBackButtonProps = {
  label: string
  onBack: () => void
}

// The single phone Back doorway visual. Every leading Back on a phone —
// the shell's route Back and any in-page local Back surfaced through the
// local-back registry — renders through this one circular icon treatment,
// with the label naming the destination for assistive technology.
export const PhoneBackButton = ({ label, onBack }: PhoneBackButtonProps) => {
  const nativeIOSPhone = useNativeIOSPhoneApp()

  return (
    <button
      aria-label={label}
      className={[
        'flex h-9 w-9 flex-shrink-0 items-center justify-center transition-colors',
        nativeIOSPhone
          ? [
              'rounded-full border border-[color-mix(in_srgb,var(--surface-inverse)_35%,transparent)]',
              'bg-[color-mix(in_srgb,var(--surface-inverse)_65%,transparent)] text-[color:var(--tx)] shadow-sm',
              'backdrop-blur-xl active:bg-[color-mix(in_srgb,var(--surface-inverse)_85%,transparent)]',
              'dark:border-[var(--overlay-strong)] dark:bg-[var(--scrim)]',
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
